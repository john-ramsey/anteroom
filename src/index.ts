/**
 * Anteroom CLI client — a fixed full-screen TUI.
 *
 * Launches into a main menu (or, with game flags, straight into a game), and returns to
 * the menu after every game. Rendering is redraw-from-state in the alternate screen with
 * single-keypress input; off a TTY it degrades to plain scrolling output + line input.
 *
 * Usage (flags are shortcuts that still return to the menu when the game ends):
 *   tsx src/index.ts                                 # main menu
 *   tsx src/index.ts --find --game rps               # matchmake into RPS (fills the
 *                                                    #   table after a short search)
 *   tsx src/index.ts --game blackjack --ante 50      # blackjack vs the dealer, for chips
 *   tsx src/index.ts --room <code>                   # join an existing room
 *   tsx src/index.ts --login                         # sign in with GitHub, then menu
 *   tsx src/index.ts --leaderboard                   # print the leaderboard and exit
 * Options: --game rps|four|reversi|blackjack|craps|roulette|slots  --best-of N  --ante N
 *          --server ws://host:port  --find  --new  --room CODE  --login  --logout  --username <name>
 *          --dev-identity <name>  --client-id <id>  --token <gh-token>  --leaderboard
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteIdentity, deviceFlowLogin, loadIdentity, saveIdentity } from "./auth.ts";
import { allocateRoom, fetchLeaderboard, matchmake, MatchmakeCancelled } from "./net.ts";
import { createTerminal, type Terminal } from "./terminal.ts";
import { runIntro } from "./screens/intro.ts";
import { runLeaderboard, runMenu, runAccount } from "./screens/menu.ts";
import { pickDoorman } from "./screens/doorman.ts";
import { playSession, type SessionResult } from "./screens/session.ts";
import { runSummary } from "./screens/summary.ts";
import { runSettings } from "./screens/settings.ts";
import { loadSettings, saveSettings, pushRecent } from "./settings.ts";
import { runSetup } from "./setup.ts";
import { agentWatchDirs, resolveClientId, resolveServer, type AgentWatch } from "./config.ts";
import { MAX_ANTE } from "@anteroom/protocol";

// Build-baked prod defaults, injected by esbuild `--define` in build.mjs. Undefined under
// tsx/dev (the `typeof` guard avoids a ReferenceError on the undeclared global), so local
// runs fall back to localhost. Runtime env vars and the --server/--client-id flags still win.
declare const __ANTEROOM_SERVER__: string;
declare const __ANTEROOM_CLIENT_ID__: string;
const BAKED_SERVER = typeof __ANTEROOM_SERVER__ !== "undefined" ? __ANTEROOM_SERVER__ : undefined;
const BAKED_CLIENT_ID =
  typeof __ANTEROOM_CLIENT_ID__ !== "undefined" ? __ANTEROOM_CLIENT_ID__ : undefined;
import { applyTheme, box, dim, neg, renderLeaderboard, sanitizeText, searchingLines, setCountryMode, setLayout, type Lifetime } from "./ui.ts";
import { screen } from "./screens/canvas.ts";
import { getGameUI } from "./screens/games/registry.ts";
import { deriveTaskState, hudLine, isAgentAlive, type TaskMarkers } from "./screens/taskHud.ts";

interface Args {
  server: string;
  room?: string;
  name: string;
  game: string;
  bestOf: number;
  ante: number;
  isNew: boolean;
  find: boolean;
  token?: string;
  username?: string;
  leaderboard: boolean;
  login: boolean;
  logout: boolean;
  devIdentity?: string;
  clientId?: string;
  /** Override the auto-discovered agent marker dirs with one explicit dir (dev). Normally unset —
   *  a bare `anteroom` watches `~/.config/anteroom/agents/*` (see agentWatchDirs). */
  watchClaude?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    server: resolveServer(process.env, BAKED_SERVER),
    name: "anon",
    game: "rps",
    bestOf: 3,
    ante: 0,
    isNew: false,
    find: false,
    login: false,
    logout: false,
    leaderboard: false,
    clientId: resolveClientId(process.env, BAKED_CLIENT_ID),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--server") a.server = argv[++i] ?? a.server;
    else if (v === "--room") a.room = argv[++i];
    else if (v === "--name") a.name = argv[++i] ?? a.name;
    else if (v === "--game") a.game = (argv[++i] ?? a.game).toLowerCase();
    else if (v === "--best-of") a.bestOf = Number(argv[++i]);
    else if (v === "--ante") a.ante = Math.min(MAX_ANTE, Math.max(0, Math.trunc(Number(argv[++i]))));
    else if (v === "--token") a.token = argv[++i];
    else if (v === "--username") a.username = argv[++i];
    else if (v === "--login") a.login = true;
    else if (v === "--logout") a.logout = true;
    else if (v === "--dev-identity") a.devIdentity = argv[++i];
    else if (v === "--client-id") a.clientId = argv[++i];
    else if (v === "--leaderboard") a.leaderboard = true;
    else if (v === "--new") a.isNew = true;
    else if (v === "--find") a.find = true;
    else if (v === "--watch-claude") a.watchClaude = argv[++i];
  }
  return a;
}

/** Parse a numbers-only JSON marker the plugin wrote into the watch dir, tolerating absence. */
function readMarker<T>(dir: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  } catch {
    return null;
  }
}

/** The plugin's content-free markers in one agent's dir: state.json `turn` (running), done.json,
 *  and the beat.json tool heartbeat (absent under the Codex recipe — tolerated). */
function readMarkers(dir: string): TaskMarkers {
  const state = readMarker<{ turn?: { startedAt?: unknown; pid?: unknown } | null }>(dir, "state.json");
  const done = readMarker<{ at?: unknown; elapsedMs?: unknown }>(dir, "done.json");
  const beat = readMarker<{ at?: unknown }>(dir, "beat.json");
  const startedAt = state?.turn?.startedAt;
  const pid = state?.turn?.pid;
  return {
    turn:
      typeof startedAt === "number"
        ? typeof pid === "number"
          ? { startedAt, pid }
          : { startedAt }
        : null,
    done: typeof done?.at === "number" ? { at: done.at, elapsedMs: typeof done.elapsedMs === "number" ? done.elapsedMs : 0 } : null,
    beat: typeof beat?.at === "number" ? { at: beat.at } : null,
  };
}

const DONE_HUD_MS = 6000; // how long the "✓ claude finished" line lingers before the HUD clears

/**
 * Watch every discovered agent's numbers-only markers and surface tasks IN-APP, so you never switch
 * back to an agent window to learn a task is still spinning — or that it's done:
 *   - a persistent top-right HUD (spinner + indeterminate bar + live m:ss) per running agent, one
 *     stacked line each, driven by the SAME `hudLine` the trailer uses (so the demo can't drift);
 *   - a labeled "<Agent> finished" toast + a brief ✓ HUD when a NEW finish lands for that agent.
 * Each agent baselines off its current done-marker so a stale finish (from before we opened) doesn't
 * fire. Markers are numbers-only — no conversation content ever crosses. Returns a stop function.
 */
function startAgentWatch(term: Terminal, targets: AgentWatch[]): () => void {
  const label = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1); // claude → Claude
  const agents = targets.map((t) => ({
    id: t.id,
    dir: t.dir,
    baselineAt: readMarkers(t.dir).done?.at ?? null,
    markers: readMarkers(t.dir),
    doneShownUntil: 0,
    doneElapsedMs: 0,
  }));
  let tick = 0;

  // Detect each agent's working→done transition on a 1s cadence; fire its labeled toast once and
  // arm the brief ✓ HUD. Caches markers for the faster animation tick below.
  const poll = setInterval(() => {
    const now = Date.now();
    for (const a of agents) {
      a.markers = readMarkers(a.dir);
      const st = deriveTaskState(a.markers, a.baselineAt, now, isAgentAlive(a.markers.turn?.pid));
      if (st?.phase === "done") {
        term.toast(`${label(a.id)} finished. Head back to your task`, { kind: "win", ms: DONE_HUD_MS });
        a.doneShownUntil = now + DONE_HUD_MS;
        a.doneElapsedMs = st.elapsedMs;
        a.baselineAt = st.at; // consume this finish so it doesn't re-fire
      }
    }
  }, 1000);

  // Animate the HUD off the cached markers + the live clock (elapsed is real; the spinner/bar are
  // indeterminate). One stacked line per agent that's working or just finished; no fs in the hot path.
  const anim = setInterval(() => {
    tick++;
    const now = Date.now();
    const lines: string[] = [];
    for (const a of agents) {
      if (now < a.doneShownUntil) {
        lines.push(hudLine({ phase: "done", at: a.baselineAt ?? now, elapsedMs: a.doneElapsedMs }, now, tick, a.id));
      } else {
        const st = deriveTaskState(a.markers, a.baselineAt, now, isAgentAlive(a.markers.turn?.pid));
        if (st?.phase === "working") lines.push(hudLine(st, now, tick, a.id));
      }
    }
    term.setStatus(lines.length ? lines : null);
  }, 150);

  poll.unref?.();
  anim.unref?.();
  return () => {
    clearInterval(poll);
    clearInterval(anim);
    term.setStatus(null);
  };
}

/**
 * Decide the identity to join with. Precedence: explicit dev identity → explicit
 * token → forced login → cached identity → tokenless dev fallback (the --name). Prints
 * to the normal screen (before the alt-screen is entered).
 */
/** The resolved session identity. `name` is the username sent on join (may be ""); `display`
 *  + `login` are for the UI (the doorman greeting + the Account screen). */
type ResolvedIdentity = { token?: string; name: string; login?: string; display?: string };

async function resolveIdentity(args: Args): Promise<ResolvedIdentity> {
  if (args.devIdentity) return { name: args.devIdentity, display: args.devIdentity };
  if (args.token) return { token: args.token, name: args.username ?? "", display: args.username };
  if (args.login) {
    const id = await deviceFlowLogin(args.clientId ?? "");
    const username = args.username ?? id.username;
    if (username && username !== id.username) await saveIdentity({ ...id, username });
    return { token: id.token, name: username ?? "", login: id.login, display: username ?? id.name };
  }
  const cached = await loadIdentity();
  if (cached) {
    const username = args.username ?? cached.username;
    if (args.username && args.username !== cached.username) {
      await saveIdentity({ ...cached, username });
    }
    const shown = username ? `${username} (@${cached.login})` : `@${cached.login}`;
    // `username` comes from a CLI flag / the cache — strip control bytes before echoing it.
    console.log(dim(`signed in as ${sanitizeText(shown)}. set a display name with --username "<name>".`));
    return { token: cached.token, name: username ?? "", login: cached.login, display: username ?? cached.name };
  }
  console.log(dim("playing as a guest. run with --login to sign in with GitHub."));
  return { name: args.name, display: args.name !== "anon" ? args.name : undefined };
}

/** Show a player id the friendly way: `@login` for a verified gh: id, else as-is. A tokenless dev
 *  id is the raw display name (untrusted), so strip control bytes before it feeds the summary. */
function displayName(userId: string): string {
  return sanitizeText(userId.startsWith("gh:") ? `@${userId.slice(3)}` : userId);
}

/**
 * Best-effort "who am I" for the leaderboard highlight + lifetime stats: an explicit
 * dev identity, else a cached GitHub account → `gh:<id>`, else a chosen `--name`.
 */
async function resolveSelfId(args: Args): Promise<string | undefined> {
  if (args.devIdentity) return args.devIdentity;
  const cached = await loadIdentity();
  if (cached) return `gh:${cached.id}`;
  if (args.name && args.name !== "anon") return args.name;
  return undefined;
}

interface PlayRequest {
  game: string;
  ante: number;
  bestOf: number;
  find: boolean;
  room?: string;
  /** "Join Room": seat if there's room, else spectate read-only (don't get refused). */
  spectate?: boolean;
}

/** A play intent from launch flags, or null when the client should open the menu. */
function initialRequest(args: Args): PlayRequest | null {
  const base = { game: args.game, ante: args.ante, bestOf: args.bestOf };
  if (args.find) return { ...base, find: true };
  // `--room CODE` mirrors the menu's "Join Room": seat if there's room, else spectate (vs being
  // refused on a full table). The room's host defines the game, so `--game` here is just a hint.
  if (args.room) return { ...base, find: false, room: args.room, spectate: true };
  if (args.isNew || args.game === "blackjack") {
    return { ...base, find: false };
  }
  return null;
}

/** Animate the matchmaking "searching" frame in the canvas while `p` is pending (TTY): a spinner,
 *  a live m:ss count-up, and — once the server's soft band lands in `state.band` — an "est. wait"
 *  range. Off a TTY paint one static frame. The timer is always cleared once `p` settles. */
async function spinWhile<T>(
  term: Terminal,
  title: string,
  sub: string[],
  p: Promise<T>,
  state: { band?: { minMs: number; maxMs: number } } = {},
  onCancel?: () => void,
): Promise<T> {
  const start = Date.now();
  const hint = onCancel ? ["", dim("[esc] cancel")] : [];
  const paint = (tick: number): void =>
    void screen(term, title, [...sub, "", ...searchingLines(tick, Date.now() - start, state.band), ...hint]);
  if (!term.tty) {
    paint(0);
    return p;
  }
  let i = 0;
  const timer = setInterval(() => paint(i++), 90);
  // Let the user back out of the wait (esc / q) — fires onCancel, which aborts the pending op.
  const offKey = onCancel
    ? term.onKey((k) => {
        if (k.name === "escape" || k.char === "q") onCancel();
      })
    : (): void => {};
  try {
    return await p;
  } finally {
    clearInterval(timer);
    offKey();
  }
}

/** Resolve a room (matchmake or allocate), then play one session. */
async function startPlay(
  term: Terminal,
  server: string,
  identity: { token?: string; name: string },
  req: PlayRequest,
): Promise<SessionResult> {
  let room = req.room;
  let ante = req.ante;
  if (req.find) {
    const sub = [dim(`${req.game}${req.ante ? ` · ante ${req.ante}` : ""}`)];
    // The server's soft wait-band arrives on the first `searching` message; spinWhile reads it
    // from `state` each frame to show the "est. wait" range alongside the live count-up.
    const state: { band?: { minMs: number; maxMs: number } } = {};
    // Let the player cancel the search (esc/q): the controller aborts matchmake (closing the
    // /find socket and dropping our queue slot); we then quietly return to the menu.
    const controller = new AbortController();
    let m: { room: string; ante: number };
    try {
      m = await spinWhile(
        term,
        "Finding players…",
        sub,
        matchmake(
          server,
          req.game,
          req.ante,
          identity,
          (band) => {
            state.band = band;
          },
          controller.signal,
        ),
        state,
        () => controller.abort(),
      );
    } catch (e) {
      if (e instanceof MatchmakeCancelled) return { reason: "cancelled" };
      throw e;
    }
    room = m.room;
    ante = m.ante; // join with the matchmaker-pinned ante (not whatever we queued for)
  } else if (!room) {
    room = await allocateRoom(server, req.game);
  }
  return playSession(term, server, identity, {
    game: req.game,
    ante,
    bestOf: req.bestOf,
    room: room!,
    spectate: req.spectate,
  });
}

/** Lifetime W–L / rank / balance for the summary, pulled from the leaderboard. */
async function lifetimeFor(server: string, selfId?: string): Promise<Lifetime | undefined> {
  if (!selfId) return undefined;
  const row = (await fetchLeaderboard(server)).find((r) => r.userId === selfId);
  if (!row) return undefined;
  return { wins: row.wins, losses: row.losses, rank: row.rank, balance: row.balance };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Apply saved settings (theme defaults to orange & blue; layout to big cards) first.
  let settings = await loadSettings();
  applyTheme(settings.theme);
  setLayout(settings.layout);
  setCountryMode(settings.country);

  // `--leaderboard` is a read-only view: fetch, print, done (no TUI).
  if (args.leaderboard) {
    const rows = await fetchLeaderboard(args.server);
    const lbWidth = Math.max(24, (process.stdout.columns ?? 80) - 4); // reserve the box borders
    console.log("\n" + box("Leaderboard", renderLeaderboard(rows, await resolveSelfId(args), lbWidth)) + "\n");
    return;
  }

  // `--logout` clears the cached GitHub identity and exits.
  if (args.logout) {
    await deleteIdentity();
    console.log("Signed out. Your GitHub identity was cleared from this device.");
    return;
  }

  // Resolve identity (may run an interactive GitHub login) BEFORE the alt-screen.
  let identity = await resolveIdentity(args);
  let selfId = await resolveSelfId(args);
  const nameForSelf = (id: string): string => displayName(id);

  const term = createTerminal();
  const flagRequest = initialRequest(args);
  let stopClaudeWatch: () => void = () => {};

  try {
    if (!term.tty) {
      // Non-interactive (piped/CI): play one flagged session, or print usage.
      if (!flagRequest) {
        console.log(
          "Anteroom — pass --find, --game blackjack, --room CODE, or --new to play " +
            "(a TTY shows the interactive menu; --find fills the table after a short search).",
        );
        return;
      }
      const result = await startPlay(term, args.server, identity, flagRequest);
      if (result.reason === "completed" && result.game && result.view !== undefined) {
        // Non-interactive: print the summary once (don't block on a keypress).
        const ui = getGameUI(result.game);
        if (ui.summary) {
          const ctx = {
            room: "",
            nameFor: nameForSelf,
            myId: "",
            myTurn: false,
            ui: { lifetime: await lifetimeFor(args.server, selfId) } as Record<string, unknown>,
            tty: term.tty,
          };
          term.paint("\n" + ui.summary(result.view, ctx).join("\n"));
        }
      }
      return;
    }

    // Zero-config: a bare `anteroom` watches every installed agent's markers (Claude and/or Codex)
    // and pings in-app when any finishes, so you needn't switch back to that window. `--watch-claude`
    // overrides with one explicit dir (dev). Off a TTY the watch is inert (setStatus/toast no-op).
    const targets: AgentWatch[] = args.watchClaude
      ? [{ id: "claude", dir: args.watchClaude }]
      : agentWatchDirs(process.env).filter((t) => existsSync(t.dir));
    if (term.tty && targets.length) stopClaudeWatch = startAgentWatch(term, targets);

    // Sit-down intro on a normal startup — skippable (any key), skipped when launched straight
    // into a game via flags (and a no-op off a TTY).
    if (!flagRequest) await runIntro(term);

    // A doorman greeting for the lobby, re-picked each time you return to the menu (a maître d'
    // who recognizes you). Guests get a plain "playing as …" line.
    const greeting = (): string =>
      identity.token ? pickDoorman(identity.display) : `playing as ${identity.display || "guest"}`;
    let pending: PlayRequest | null = flagRequest;
    while (true) {
      let req: PlayRequest;
      if (pending) {
        req = pending;
        pending = null;
      } else {
        const action = await runMenu(term, greeting(), settings.recent);
        if (action.type === "quit") break;
        if (action.type === "leaderboard") {
          await runLeaderboard(term, args.server, selfId);
          continue;
        }
        if (action.type === "account") {
          const choice = await runAccount(term, {
            signedIn: !!identity.token,
            name: identity.display ?? identity.name,
            login: identity.login,
          });
          if (choice === "signout" && identity.token) {
            await deleteIdentity();
            identity = { name: args.name, display: args.name !== "anon" ? args.name : undefined };
            selfId = undefined;
          }
          continue;
        }
        if (action.type === "settings") {
          settings = await runSettings(term, settings);
          continue;
        }
        if (action.type === "joinRoom") {
          // Join a friend's table by code: seat if open, else spectate. The room defines the
          // game/config, so `game` here is just a placeholder until the `joined` frame arrives.
          req = { game: "rps", ante: 0, bestOf: args.bestOf, find: false, room: action.code, spectate: true };
        } else {
          req = { game: action.game, ante: action.ante, bestOf: args.bestOf, find: action.find };
        }
      }

      // Remember this game for the home menu's "Recent" shortlist — any real game launch (menu
      // pick, replay, or a --game flag), but NOT a Join-Room (its `game` is a placeholder until the
      // room's `joined` frame names the real game). Persist only when the order actually changes.
      if (!req.room) {
        const recent = pushRecent(settings.recent, req.game);
        if (recent.join("\n") !== settings.recent.join("\n")) {
          settings = { ...settings, recent };
          await saveSettings(settings);
        }
      }

      const result = await startPlay(term, args.server, identity, req);
      if (result.reason === "completed" && result.game && result.view !== undefined) {
        // One-shot match summary (RPS, four-in-a-row, …) — rendered by the game's GameUI.
        const next = await runSummary(
          term,
          result.game,
          result.view,
          nameForSelf,
          await lifetimeFor(args.server, selfId),
        );
        if (next === "again") pending = req;
        else if (next === "quit") break;
      } else if (result.reason === "inactivity") {
        screen(term, "Inactivity", [neg("you were removed for inactivity")], "any key to return");
        await term.readKey();
      } else if (result.reason === "error") {
        screen(term, "Disconnected", [neg(result.message ?? "connection error")], "any key to return");
        await term.readKey();
      } else if (result.reason === "table_end") {
        // The server closed the table (roster fell below the game's minimum) — tell the
        // player why they're back at the menu instead of silently dropping them there.
        screen(term, "Table closed", [dim(result.message ?? "the table ended")], "any key to return");
        await term.readKey();
      } else if (result.reason === "broke") {
        // A bankroll table couldn't re-stake: the wallet is below the minimum bet.
        screen(term, "Out of chips", [neg("your balance can't cover the minimum bet")], "any key to return");
        await term.readKey();
      }
      // left / disconnected / continuous/settle completed → back to the menu
    }
  } finally {
    stopClaudeWatch();
    term.restore();
  }
}

// `anteroom setup` wires the hooks into Claude/Codex; everything else launches the game client.
if (process.argv[2] === "setup") {
  void runSetup(process.argv.slice(3));
} else {
  void main();
}
