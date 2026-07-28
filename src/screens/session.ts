/**
 * A single game session — the GENERIC shell, rendered in the shared full-screen canvas.
 *
 * Owns the room WebSocket + the protocol message loop, the turn clock, the staked
 * ante/settlement UX, and the in-app toasts. It is GAME-AGNOSTIC: it carries NO
 * `if (game === ...)` branching — the board, the control hints, the input mapping, any
 * transition animation, the status lines, and the completion behaviour all come from the
 * per-game `GameUI` resolved via `getGameUI(game)` (see screens/games/).
 *
 * Rendering is redraw-from-state via the shared canvas (`screens/canvas.ts`) and single
 * keypresses via `term.onKey` — no scrolling, no readline. Resolves a `SessionResult`
 * when the match ends / the player leaves / the socket closes, so the app shell can return
 * to the menu (or show a per-game summary).
 *
 * Completion (from `GameUI.completion`):
 *   - "summary"    → one-shot; resolves `completed` with the final view (shell shows a summary).
 *   - "continuous" → a table that stays seated across rounds; resolves only on leave/disconnect.
 *   - "settle"     → one-shot intrinsic; holds the socket open for the settlement, then returns.
 */
import { encode, decode, MAX_ANTE, type RoomStatus, type ServerMessage } from "@anteroom/protocol";
import type { Key, Terminal } from "../terminal.ts";
import { accent, bold, countryTag, dim, neg, pos, sanitizeText, tallyFrames, warn } from "../ui.ts";
import { screen, sizeCanvas } from "./canvas.ts";
import { pickWelcome } from "./dealer.ts";
import { getGameUI } from "./games/registry.ts";
import type { GameCtx, GameUiState } from "./games/types.ts";

export interface SessionOpts {
  game: string;
  ante: number;
  bestOf: number;
  room: string;
  /** "Join Room": ask to be seated, but if the table is full WATCH it read-only
   *  instead of being refused. The server decides; a `joined.spectator` flag confirms watching. */
  spectate?: boolean;
}

export interface SessionResult {
  // "cancelled" = the player backed out of matchmaking before a table was found (returns to menu).
  // "table_end" = the server closed the table (roster below minimum — no further rounds).
  // "broke" = a bankroll table couldn't re-stake: the wallet is below the minimum bet.
  reason: "completed" | "left" | "cancelled" | "inactivity" | "disconnected" | "error" | "table_end" | "broke";
  /** The game id (so the shell can resolve the summary renderer). */
  game?: string;
  /** The final view, for the summary screen (one-shot games only). Opaque. */
  view?: unknown;
  message?: string;
  /**
   * The display names this session learned, by player id — the roster, carried OUT of the session
   * so the end-of-match summary can still say who everyone was. The summary screen runs after the
   * socket is gone, and without this the shell has only ids: a signed-in player's `gh:<numericId>`
   * then rendered as a bare `@68801528` on the reversi score line (and for opponents in the RPS
   * recap). See test/summaryNames.test.ts.
   */
  names?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Minimum staked bet (mirrors the server's minimum — the server clamps too). */
const MIN_BET = 5;
/** Show the per-move countdown only inside its final minute. A shared table's 10s clock always
 *  shows; a solo safety-valve clock (slots' 10-minute `moveClockMs`) stays out of the footer
 *  until it actually matters — a number like "600s" reads as pressure, not information. */
const TURN_CLOCK_SHOW_S = 60;

/**
 * Lay out the footer: the control hints + the leave hint. PURE.
 *
 * `reserve` is the game's (stable) control-line count, so the footer keeps the SAME height
 * whether or not it's your turn — the board never bumps between turn states. A game whose
 * controls fit one row (RPS/Blackjack/…) gets the compact single-row footer (hint + leave on one
 * line, unchanged). A game that needs MULTIPLE control rows (the house tables) gets each hint on
 * its own row + a leave row — never collapsing them onto one over-wide line that would overrun the
 * canvas box (the roulette/craps footer was ~141 cols when joined).
 */
export function footerRows(hints: string[], reserve: number, leave: string): string[] {
  const rows = Math.max(reserve, hints.length, 1);
  if (rows <= 1) {
    const hint = hints[0] ?? "";
    return [hint ? `${hint}    ${dim(leave)}` : dim(leave)];
  }
  const region = Array.from({ length: rows }, (_, i) => hints[i] ?? "");
  return [...region, dim(leave)];
}

/** Whole seconds until an epoch-ms deadline, rounded UP and floored at 0 — the ONE countdown
 *  convention (the turn clock and the between-rounds row must never disagree). PURE. */
export function secsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * The keys that leave a table. `m` for menu, because that is what leaving does — it returns you to
 * the main menu, never to a closed program. `q` is deliberately NOT here: it quits the app from the
 * main menu, and one key that sometimes exits the process and sometimes doesn't is the confusion
 * this contract exists to remove (test/keys.test.ts).
 */
export const LEAVE_KEYS: { chars: readonly string[]; names: readonly string[] } = {
  chars: ["m"],
  names: ["escape"],
};

/**
 * The footer's leave row. Between rounds (`nextRoundAt` pending, from `result.nextRoundAt` or a
 * mid-gap `state` snapshot) it becomes the between-rounds line: a live countdown to
 * the next round's boundary (where the table re-antes the same stake and deals again),
 * that staying seated auto-plays you into it, and how to leave — one ≤58-col line (the canvas floor,
 * see layoutOverflow.test.ts). Seconds round UP so it never reads 0s while time remains. A
 * spectator isn't seated, so their line skips the stay hint (the queue row covers their state).
 * PURE.
 */
export function leaveHint(base: string, nextRoundAt: number | null, now: number, seated: boolean): string {
  if (nextRoundAt === null) return base;
  return `next round in ${secsUntil(nextRoundAt, now)}s${seated ? " · stay to auto-play" : ""} · ${base}`;
}

export function playSession(
  term: Terminal,
  server: string,
  identity: { token?: string; name: string },
  opts: SessionOpts,
): Promise<SessionResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server}/connect?room=${encodeURIComponent(opts.room)}`);

    let gameId = opts.game;
    let ui = getGameUI(gameId);
    let myId = identity.name;
    // A bankroll game is staked with NO chosen ante — the session stakes from the live balance
    // (min(balance, MAX_ANTE), or min(balance, --ante) when one was passed) once the lobby
    // reveals it, so opts.ante alone can't decide stakedness.
    let staked = opts.ante > 0 || ui.menu.stake === "bankroll";
    let continuous = false;
    let view: unknown = null;
    let prevView: unknown = null;
    let uiState: GameUiState = ui.initUi ? ui.initUi() : {};
    let status: RoomStatus = "lobby";
    let turnDeadline: number | undefined;
    // When the next round of a continuous table auto-deals (epoch ms, from `result.nextRoundAt`)
    // — drives the between-rounds countdown in the footer; null outside the inter-round gap.
    let nextRoundAt: number | null = null;
    let myTurn = false;
    let balance: number | null = null;
    let antedThisRound = false;
    let roundIdx = 0; // which round of a continuous table we're on (0 = first)
    // Between-rounds re-staking: on a continuous staked table the player can change
    // their bet in the re-ante window before it auto-locks.
    let lastDeltas: Record<string, number> | undefined;
    let statusLine = "";
    let animating = false;
    let finished = false;
    // Set the moment a `result` reveals we're leaving after the settlement (`stayAfterSettle`
    // said don't stay): suppresses the between-rounds countdown (a promise we won't keep) and
    // blocks the re-ante lobby from staking a fresh slice if the server's inter-round boundary
    // outraces our exit.
    let leaving = false;
    // The board's vertical budget (canvas body minus the footer block), refreshed each render —
    // handed to the game via ctx so a tall layout can adapt instead of being silently cropped
    // by the canvas (see GameCtx.boardRows). undefined until the first render measures it.
    let boardRows: number | undefined;
    // The horizontal counterpart to boardRows (the canvas body width, CW), so a wide layout can
    // adapt instead of being truncated by the canvas (see GameCtx.boardCols).
    let boardCols: number | undefined;
    let spectating = false; // set true when the server seats us as a read-only watcher
    let queuePos: number | null = null; // our place in the auto-queue while watching
    let queueSize = 0;

    const profiles = new Map<string, { name: string; country?: string; disconnected?: boolean }>();
    const displayId = (id: string): string => (id.startsWith("gh:") ? `@${id.slice(3)}` : id);
    const nameFor = (id: string): string => {
      const p = profiles.get(id);
      // The display name (and a tokenless dev id) is untrusted remote text — strip control bytes
      // before it's coloured and painted onto the board (see sanitizeText). This is the single
      // choke every game renders seat/roster names through (via ctx.nameFor).
      const n = sanitizeText(p?.name ?? displayId(id));
      const base = `${n}${countryTag(p?.country)}`;
      return p?.disconnected ? `${base} ${dim("(away)")}` : base;
    };

    /** The render/input context handed to the active game UI. */
    function ctx(): GameCtx {
      return { room: opts.room, nameFor, myId, myTurn, ui: uiState, lastDeltas, balance, boardRows, boardCols, tty: term.tty };
    }

    /** The roster as display names, for the summary screen (see SessionResult.names). The
     *  transient "(away)" marker is deliberately left off — it describes a live socket, and by the
     *  time this is read there are none. */
    function rosterNames(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [id, p] of profiles) out[id] = `${sanitizeText(p.name)}${countryTag(p.country)}`;
      return out;
    }

    function finish(result: SessionResult): void {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      offKey();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve({ names: rosterNames(), ...result });
    }

    // --- rendering ----------------------------------------------------------

    /** The footer: (on your turn) the game's control hints + the leave hint. The ephemeral STATUS
     *  line is NOT here — it rides the canvas's reserved note row (see paintBody), so it can appear
     *  and clear without bumping the board upward. This line is always exactly one row, so the
     *  board's vertical position never changes.
     *
     *  While a transition animation is playing the footer goes BLANK — same rows, no content. The
     *  footer answers "what can you do right now", and mid-deal (or mid-spin, mid-tumble) the
     *  answer is nothing: the frames are a cutscene, and offering "[q] leave table" or "[h]it"
     *  over cards that are still landing invites a keypress the moment isn't ready for. The rows
     *  stay reserved rather than being dropped, so the board doesn't slide down for the length of
     *  the animation and snap back when it ends. */
    function footerLines(): string[] {
      return animating ? footerContent().map(() => "") : footerContent();
    }

    /** The footer's content, ignoring whether an animation is covering it. */
    function footerContent(): string[] {
      // A continuous/settle table "leaves"; a one-shot wager match "quits" the app loop.
      // Between rounds the row carries the countdown + stay/leave hints (see leaveHint).
      const leave = leaveHint(
        ui.completion === "summary" ? "[m] menu" : "[m] leave table",
        nextRoundAt,
        Date.now(),
        !spectating,
      );
      if (spectating) {
        const hints = [dim("spectating")];
        if (queuePos !== null) hints.push(dim(`queued #${queuePos} of ${queueSize} · auto-seated when a seat opens`));
        return footerRows(hints, hints.length, leave);
      }
      // The game's control-line count is stable (it doesn't depend on whose turn it is), so reserve
      // that height even off-turn — the board never shifts between turn states (see footerRows).
      const controlLines = view ? ui.controls(view, ctx()) : [];
      const reserve = Math.max(1, controlLines.length);
      let hints: string[] = [];
      if (myTurn && view) {
        const secs = turnDeadline ? secsUntil(turnDeadline, Date.now()) : null;
        // Only tick inside the final minute: a long safety-valve clock (slots' 10-minute
        // moveClockMs) is not a countdown to race — showing "600s" would read as pressure.
        const show = secs !== null && secs <= TURN_CLOCK_SHOW_S;
        const clock = show ? `   ${secs <= 3 ? neg(`${secs}s`) : dim(`${secs}s`)}` : "";
        hints = [...controlLines];
        if (hints.length > 0) hints[0] += clock;
      }
      return footerRows(hints, reserve, leave);
    }

    /** The current canvas frame title: the game's live board title, or the static title. */
    function frameTitle(): string {
      return view && ui.boardTitle ? ui.boardTitle(view, ctx()) : ui.title;
    }

    /** The game board content lines (or the pre-game lobby panel when there's no view yet). */
    function bodyLines(): string[] {
      if (view) return ui.render(view, ctx());
      // Pre-game: a lobby / waiting panel. The room code can be shared/attacker-chosen, so strip
      // control bytes before echoing it.
      const lines = [dim(`room ${bold(sanitizeText(opts.room))}`)];
      if (staked) {
        lines.push(
          dim(
            ui.menu.stake === "bankroll"
              ? "staked from your balance"
              : `${ui.menu.stake === "buyin" ? "buy-in" : "ante"} ${opts.ante} chips`,
          ),
        );
      }
      lines.push("", dim(status === "ante" ? "confirming ante…" : "waiting for the table…"));
      return lines;
    }

    /** Frame board content lines + the footer into the shared canvas (used by render + the
     *  per-game transition animations, which hand a full board string here). The ephemeral status
     *  goes to the canvas's reserved note row — never into the centered content — so the board's
     *  position is fixed regardless of whether a status is showing. */
    function paintBody(body: string): void {
      const content = [...body.split("\n"), "", ...footerLines()];
      screen(term, frameTitle(), content, statusLine);
    }

    /** Measure the board's vertical budget: the canvas body is CH−1 rows (bottom row = the
     *  note), paintBody spends 1 on the blank separator and the footer takes the rest —
     *  whatever remains is the game's. The footer height is stable by design (footerRows
     *  reserves it), so measuring with the previous budget can't oscillate. Refreshed before
     *  every render AND before a transition animation, so both pick the same layout. */
    function measureBoardRows(): void {
      const { CW, CH } = sizeCanvas(term);
      boardRows = Math.max(1, CH - 2 - footerLines().length);
      boardCols = CW;
    }

    function render(): void {
      if (animating) return;
      measureBoardRows();
      paintBody(bodyLines().join("\n"));
    }

    // Repaint on a cadence so the turn countdown / between-rounds countdown tick down without a
    // server message. (render() already no-ops mid-animation.) A far-out turn deadline doesn't
    // repaint — the clock is hidden beyond TURN_CLOCK_SHOW_S, so there'd be nothing to tick; the
    // interval's live check picks the countdown up the moment it crosses into the final minute.
    const ticker = setInterval(() => {
      const clockTicking = myTurn && turnDeadline !== undefined && secsUntil(turnDeadline, Date.now()) <= TURN_CLOCK_SHOW_S;
      if (clockTicking || nextRoundAt !== null) render();
    }, 500);

    // --- input --------------------------------------------------------------

    // --- between-rounds re-staking -------------------------------

    function handleKey(k: Key): void {
      if (LEAVE_KEYS.chars.includes(k.char) || LEAVE_KEYS.names.includes(k.name ?? "")) {
        finish({ reason: "left" });
        return;
      }
      if (!myTurn || !view) return;
      const res = ui.onKey(k, view, ctx());
      if (!res) return;
      if ("move" in res) {
        ws.send(encode({ type: "move", move: res.move }));
        if (!res.keepTurn) myTurn = false;
        if (res.status !== undefined) statusLine = res.status;
      } else if (res.status !== undefined) {
        statusLine = res.status;
      }
      render();
    }
    const offKey = term.onKey(handleKey);

    // --- protocol loop ------------------------------------------------------

    ws.addEventListener("open", () => {
      ws.send(
        encode({
          type: "join",
          name: identity.name,
          token: identity.token,
          config: { game: opts.game, bestOf: opts.bestOf, ante: opts.ante },
          spectateIfFull: opts.spectate ? true : undefined,
        }),
      );
    });

    // Serialize handling so an async reveal animation finishes before the next message.
    let chain: Promise<void> = Promise.resolve();
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = decode<ServerMessage>(ev.data as string);
      chain = chain.then(() => handle(msg)).catch(() => {});
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      if (finished) return;
      finish({ reason: ev.code === 4002 ? "inactivity" : "disconnected" });
    });
    ws.addEventListener("error", () => {
      if (!finished) finish({ reason: "error", message: "connection error" });
    });

    async function handle(msg: ServerMessage): Promise<void> {
      // Frames queued behind the settlement's exit beat (`balance`, a late `state`) can land
      // after finish() resolved — the next screen owns the terminal now; never repaint over it.
      if (finished) return;
      switch (msg.type) {
        case "joined": {
          myId = msg.you.id;
          gameId = msg.game;
          ui = getGameUI(gameId);
          uiState = ui.initUi ? ui.initUi() : {};
          continuous = msg.continuous;
          // The room code is echoed into the lobby status lines below; it can be shared or
          // attacker-chosen, so strip control bytes before it reaches the canvas.
          const room = sanitizeText(msg.room);
          // Joining an existing room can change the game (opts.game was only what we asked for).
          if (ui.menu.stake === "bankroll") staked = true;
          // Greet on your FIRST arrival at a populated casino table (a continuous table with
          // someone already seated). We don't narrate the existing roster — those arrive as silent
          // `backfill` opponent frames — so a dealer line welcomes you instead. `spectating` here
          // is still the PRIOR state, so this is skipped on a promotion (you were already greeted
          // when you sat down to watch) and on an empty table (you're the first one here).
          const arrivingFresh = !spectating;
          if (arrivingFresh && msg.continuous && msg.players.some((id) => id !== msg.you.id)) {
            term.toast(pickWelcome(), { kind: "info" });
          }
          // Read-only watcher: never seat-act. Skip the host `ready` + the ante flow entirely;
          // we just receive the public board (the footer carries the "spectating" indicator).
          if (msg.spectator) {
            spectating = true;
            render();
            break;
          }
          // A NON-spectator `joined` while watching = we were auto-queued and just got promoted
          // into an open seat. Drop watch mode and play from here (the normal seated flow below).
          const promoted = spectating;
          spectating = false;
          queuePos = null;
          if (promoted) term.toast("you're in — seated at the table", { kind: "win" });
          profiles.set(myId, { name: sanitizeText(msg.you.name), country: msg.you.country });
          // You took a seat BEHIND someone already at the table ⇒ you JOINED an open table (vs
          // created it). A joiner just confirms "joined table {code}"; the host (alone in seat 0)
          // is the one who shares the code / waits for others.
          const joinedOpenTable = !promoted && msg.you.seat > 0;
          // Friendly continuous/settle tables are host-dealt; a staked one starts via the ante.
          if (ui.completion !== "summary" && !staked) {
            ws.send(encode({ type: "ready" }));
            if (joinedOpenTable) statusLine = dim(`joined table ${bold(room)}`);
          }
          // A one-shot wager table still in the lobby: the host (a matchmaker-filled table is
          // pre-seeded server-side, so it would already be "playing") shares the code to recruit
          // an opponent; a joiner of an already-open table just confirms the join.
          else if (msg.status === "lobby" && ui.completion === "summary") {
            statusLine = joinedOpenTable
              ? dim(`joined table ${bold(room)}`)
              : dim(`waiting for an opponent — share code ${bold(room)}`);
          }
          // A staked table you joined (vs created): confirm it — the ante flow takes the status next.
          else if (joinedOpenTable) {
            statusLine = dim(`joined table ${bold(room)}`);
          }
          render();
          break;
        }
        case "opponent": {
          // The name is untrusted remote text — sanitize once here so both the stored profile and
          // the toast interpolations below (which bypass nameFor) carry no terminal-control bytes.
          const name = sanitizeText(msg.name);
          // `disconnected` toggles a transient away-flag; joined/reconnected/left clear it.
          if (msg.id) {
            const prev = profiles.get(msg.id);
            profiles.set(msg.id, {
              name,
              country: msg.country ?? prev?.country,
              disconnected: msg.event === "disconnected",
            });
          }
          // Backfill = the roster that already existed when you arrived (a spectator's roster
          // replay, or players already seated as you sat). Update the labels silently — you only
          // hear about people who arrive AFTER you (and you were greeted with a dealer line on arrival).
          if (msg.backfill) {
            render();
            break;
          }
          if (msg.event === "joined") term.toast(`${name} joined`, { kind: "info" });
          else if (msg.event === "reconnected") term.toast(`${name} reconnected`, { kind: "info" });
          else if (msg.event === "left") term.toast(`${name} left the table`, { kind: "warn" });
          else if (msg.event === "disconnected") term.toast(`${name} disconnected…`, { kind: "warn" });
          render();
          break;
        }
        case "state": {
          status = msg.status;
          turnDeadline = msg.turnDeadline;
          // A mid-gap join/reconnect learns the between-rounds deadline from the snapshot. A
          // state frame never CLEARS the countdown (play-time frames simply don't carry it) —
          // only `round` / `table_end` close the window.
          if (msg.nextRoundAt !== undefined) nextRoundAt = msg.nextRoundAt;
          const next = msg.view;
          // Let the game animate the prev→next transition (RPS reveal, four drop/win pulse).
          if (ui.onView) {
            measureBoardRows(); // the animation must pick the same layout the render will
            animating = true;
            try {
              await ui.onView(prevView, next, ctx(), paintBody);
            } finally {
              animating = false;
            }
          }
          prevView = next;
          view = next;
          // The game derives "your turn" + an optional status line from the fresh view. A watcher
          // never owns a turn (it holds no seat), so force it off regardless of what the view says.
          myTurn = spectating ? false : ui.isMyTurn(next, msg.status === "playing");
          // Entering play clears any lingering lobby banner ("waiting — share code" / "joined
          // table"): a game whose status() returns null on the opening frame (RPS before you throw)
          // must not keep showing the stale lobby message once the match has actually begun.
          if (msg.status === "playing") statusLine = "";
          const s = ui.status ? ui.status(next, ctx()) : null;
          if (s !== null && s !== undefined) statusLine = s;
          render();
          break;
        }
        case "result": {
          lastDeltas = undefined;
          // Open the between-rounds window: the footer's leave row counts down to this deadline
          // (ticked by the repaint cadence) until the `round` message closes it. Absent on a
          // one-shot match or when the table is ending, so the countdown simply doesn't show.
          nextRoundAt = msg.nextRoundAt ?? null;
          // Leaving after the settle (a slots cash-out): the server still advertises the next
          // round — it can't know this client won't stay — but WE do, so never show a countdown
          // to a round we won't attend, and never let the re-ante lobby stake us into it.
          if (ui.completion === "continuous" && ui.stayAfterSettle && view && !ui.stayAfterSettle(view)) {
            nextRoundAt = null;
            leaving = true;
          }
          // A watcher has no stake/summary: keep watching a continuous table; on a one-shot end,
          // rest on the final board with a leave hint (no player win/loss summary screen).
          // Mirrors the seated branch below: no deadline ⇒ the table is ending (a `table_end`
          // follows once the settle completes) — don't imply another deal is coming.
          if (spectating) {
            statusLine = dim(
              continuous ? (nextRoundAt !== null ? "hand over" : "hand over — [m] leave") : "game over — [m] leave",
            );
            render();
            break;
          }
          if (ui.completion === "continuous") {
            // The footer carries the countdown + stay/leave hints; the status row stays free for
            // the settlement tally. No deadline ⇒ no next round is coming (the table is ending).
            statusLine = dim(nextRoundAt !== null ? "hand over" : "hand over — [m] leave");
            render();
          } else if (ui.completion === "settle") {
            // One-shot intrinsic: keep the socket open a beat so the settlement (the cash-out
            // net + new balance) lands, then return to menu (see the `settlement` case).
            myTurn = false;
            statusLine = dim("session over — settling…");
            render();
          } else {
            // One-shot wager: hand the final view to the summary screen.
            finish({ reason: "completed", game: gameId, view });
          }
          break;
        }
        case "round": {
          prevView = null;
          antedThisRound = false;
          nextRoundAt = null; // the round arrived — close the between-rounds countdown
          roundIdx = msg.roundIdx;
          statusLine = dim(`round ${msg.roundIdx + 1}`);
          render();
          break;
        }
        case "table_end": {
          // The table can't continue (roster fell below the game's minimum) — the server
          // revoked the between-rounds promise explicitly, so leave rather than wait forever.
          nextRoundAt = null;
          finish({ reason: "table_end", game: gameId, message: "the table ended — not enough players to continue" });
          break;
        }
        case "lobby": {
          if ((msg.ante ?? 0) > 0) staked = true;
          const stake = msg.ante ?? 0;
          for (const p of msg.players) profiles.set(p.id, { name: sanitizeText(p.name), country: p.country });
          // The lobby carries the wallet truth — keep the local figure in sync (a bankroll
          // slice is computed from it; the re-ante window shows it).
          const lobbyBal = msg.balances?.[myId];
          if (lobbyBal !== undefined) balance = lobbyBal;
          if (stake > 0 && !antedThisRound && !spectating && !leaving) {
            if (ui.menu.stake === "bankroll") {
              // Bankroll table (slots): the stake is a SLICE of the live balance — no prompt,
              // no window. min(balance, MAX_ANTE), or min(balance, --ante) when one was passed.
              // Busting just cuts a fresh slice here next lobby, so play feels like drawing
              // straight down from the wallet; the escrow is an invisible detail.
              const cap = opts.ante > 0 ? Math.min(opts.ante, MAX_ANTE) : MAX_ANTE;
              const slice = Math.min(balance ?? cap, cap);
              if (slice < MIN_BET) {
                term.toast("out of chips — the machine can't deal you in", { kind: "warn" });
                finish({ reason: "broke", game: gameId, view });
                break;
              }
              antedThisRound = true;
              statusLine = dim(`staking ${slice} from your balance…`);
              ws.send(encode({ type: "bet", ante: slice }));
            } else {
              // EVERY round antes the same stake, immediately — the first one because it was just
              // chosen in the menu, and each one after because the stake is a property of the
              // TABLE you sat down at, not a per-hand decision. Changing it means leaving and
              // re-queueing. (There used to be a between-rounds betting window here; it stopped
              // the table to ask a question almost nobody answered, and it auto-locked the same
              // number anyway.)
              if ((balance ?? stake) < stake) {
                // Can't cover the next hand. Leaving beats silently dropping to a smaller stake
                // the player never chose, and beats stalling until the server's ante deadline.
                term.toast("not enough chips for the next hand", { kind: "warn" });
                finish({ reason: "broke", game: gameId, view });
                break;
              }
              antedThisRound = true;
              statusLine = dim(`anteing ${stake} chips…`);
              ws.send(encode({ type: "bet", ante: stake }));
            }
          }
          render();
          break;
        }
        case "ante_result": {
          if (msg.outcome === "escrowed") statusLine = pos(`pot ${msg.pot} — game on!`);
          else {
            statusLine = warn("ante aborted — back to lobby");
            antedThisRound = false;
          }
          render();
          break;
        }
        case "settlement": {
          lastDeltas = msg.deltas;
          const d = msg.deltas[myId] ?? 0;
          const signed = d > 0 ? pos(`+${d}`) : d < 0 ? neg(`${d}`) : warn("0");
          const newBal = msg.balances[myId];
          const label = `${bold("settlement")} ${signed}`;
          term.toast(
            d > 0 ? `you won +${d} chips` : d < 0 ? `you lost ${-d} chips` : "a push — chips returned",
            { kind: d > 0 ? "win" : d < 0 ? "warn" : "info" },
          );
          // Tally the balance up/down to the new total in the status line (the payoff moment),
          // when we have both ends and a real change. Otherwise just show the final figure.
          if (newBal !== undefined && balance !== null && balance !== newBal && term.tty) {
            // The tally is decorative: a throw mid-frame (e.g. a view this renderer can't draw)
            // must neither strand `animating` — freezing every future render — nor skip the
            // completion logic below, which is money-flow navigation, not decoration.
            animating = true;
            try {
              for (const f of tallyFrames(label, balance, newBal)) {
                statusLine = f;
                paintBody(bodyLines().join("\n"));
                await sleep(55);
              }
            } catch {
              /* a broken animation is not a broken settlement */
            } finally {
              animating = false;
            }
            balance = newBal;
          } else {
            if (newBal !== undefined) balance = newBal;
            statusLine = `${label}${balance !== null ? dim(`  ·  ${balance} chips`) : ""}`;
            try {
              render();
            } catch {
              /* same rule: display trouble must not block the completion logic below */
            }
          }
          // A one-shot intrinsic ("settle") game ends at settlement: show the net a beat, then return.
          if (ui.completion === "settle" && !continuous) {
            await sleep(1800);
            finish({ reason: "completed", game: gameId, view });
          }
          // A continuous table can also CHOOSE to leave after a settlement (`stayAfterSettle`):
          // slots stays only on a bust (the next lobby silently re-buys); a voluntary cash-out
          // banks the chips and exits with the final view — show the net a beat, then return.
          else if (ui.completion === "continuous" && ui.stayAfterSettle && view && !ui.stayAfterSettle(view)) {
            await sleep(1800);
            finish({ reason: "completed", game: gameId, view });
          }
          break;
        }
        case "balance": {
          balance = msg.snapshot.balance;
          render();
          break;
        }
        case "queue": {
          // Our place in the auto-queue while watching — shown in the spectating footer.
          queuePos = msg.pos;
          queueSize = msg.size;
          render();
          break;
        }
        case "error": {
          // Server-supplied error text is untrusted — strip control bytes before it lands in the
          // status line (the toast path sanitizes independently, in renderToast).
          const message = sanitizeText(msg.message);
          statusLine = neg(`! ${message}`);
          term.toast(message, { kind: "warn" });
          render();
          break;
        }
      }
    }
  });
}
