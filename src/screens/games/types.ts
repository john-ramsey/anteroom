/**
 * The client-side `GameUI` seam — the per-game contract the generic session shell talks
 * to, mirroring how the server stays game-agnostic across games.
 *
 * A new game is a self-contained module in `screens/games/` that implements this and is
 * registered in `screens/games/registry.ts`. The shell (session.ts), the menu, and ui.ts
 * carry ZERO `if (game === ...)` branching — they iterate / resolve through the registry.
 *
 * Keep the interface MINIMAL: only what the existing games need, extended ADDITIVELY (an
 * optional field) when a new game genuinely needs a new hook — never a game-id branch.
 */
import type { Key } from "../../terminal.ts";

/** Per-game-instance local UI state (e.g. the four-in-a-row column cursor, the craps bet).
 *  Opaque to the shell; each game reads/writes its own shape via `ctx.ui`. */
export type GameUiState = Record<string, unknown>;

/** Everything a renderer / input handler needs from the live session, besides the view. */
export interface GameCtx {
  /** The room / table code (shown in titles). */
  room: string;
  /** Map a player id to a display label (flags, "(away)", gh: → @login). */
  nameFor: (id: string) => string;
  /** The viewer's server-assigned id (balances/winner are keyed by id). */
  myId: string;
  /** Whether it's currently the viewer's turn (drives the cursor / control hints). */
  myTurn: boolean;
  /** Per-game local UI state (see `initUi`); mutated by `onKey`. */
  ui: GameUiState;
  /** The latest settlement deltas (per id), if any — used to annotate a finished board. */
  lastDeltas?: Record<string, number>;
  /** The viewer's wallet balance, when known (from the lobby/settlement broadcasts; null before).
   *  Lets a bankroll game show the wallet behind the machine — the board's own money figures
   *  still come only from the server view. */
  balance?: number | null;
  /** The content rows available to `render` inside the canvas this paint (the canvas body minus
   *  the footer block). The canvas silently DROPS overflow rows, so a game whose tallest layout
   *  can exceed this must adapt rather than let seats be cropped — e.g. blackjack's big-cards →
   *  compact ladder (mirrors the menu preview's fit-or-hide rule). Absent when unknown. */
  boardRows?: number;
  /** The content COLUMNS available to `render` inside the canvas this paint (the canvas body
   *  width, CW). The horizontal counterpart to `boardRows`: a game whose widest layout can exceed
   *  this should adapt (e.g. RPS's reveal panel stacks vertically instead of running off the edge)
   *  rather than let the canvas truncate it. Absent when unknown. */
  boardCols?: number;
  /** Whether we're on a real TTY (animations redraw in place; off-TTY they print once). */
  tty: boolean;
}

/** The result of mapping a keypress:
 *  - `{ move }`        — send this server move. `status` is an optional footer hint to show
 *                        optimistically (e.g. "you played ROCK — waiting…"); `keepTurn` keeps
 *                        the turn window open (a craps bet) rather than ending the turn.
 *  - `{ handled }`     — a local UI change already applied to `ctx.ui`; just repaint.
 *  - `null`            — ignore the key. */
export type KeyResult =
  | { move: unknown; status?: string; keepTurn?: boolean }
  | { handled: true; status?: string }
  | null;

/**
 * How a game finishes, so the shell knows what to do on the server `result` message:
 * - "summary"    — one-shot; resolve `completed` with the final view → the shell shows a summary.
 * - "continuous" — a table that stays seated across rounds; resolve only on leave/disconnect.
 * - "settle"     — one-shot but intrinsic: hold the socket open for the settlement, then return.
 */
export type Completion = "summary" | "continuous" | "settle";

/** What a game contributes to the menu (drives the data-driven menu — no hand-numbered switch). */
export interface MenuSpec {
  /** The menu row label, e.g. "Blackjack". */
  label: string;
  /** The stake prompt to show: a winner-take-all wager, a craps-style buy-in, "bankroll" (NO
   *  prompt — the session stakes min(balance, MAX_ANTE) automatically and silently re-stakes
   *  from the live balance between rounds, so play feels like drawing straight down from the
   *  wallet; slots), or no stake. */
  stake: "wager" | "buyin" | "bankroll" | "none";
  /** Pre-filled default for the wager/buy-in prompt — each staked game states its
   *  own instead of sharing one hardcoded figure. Unused for "bankroll"/"none". */
  defaultStake?: number;
  /** Whether to matchmake (`--find`) vs allocate a fresh room. */
  find: boolean;
  /** A short, one-line description shown under the name in the category submenu (e.g. "Beat the
   *  dealer to 21."). Keep it tight — it sits in the narrow left column. */
  blurb: string;
  /** The seat count, shown beside the stake in the submenu (e.g. "2P", "2-6P", "Solo"). A plain
   *  display string (the authoritative min/max live on the server). */
  players: string;
}

/**
 * The per-game client UI module. `view` is the opaque server view (each game narrows it to
 * its own shape); the shell never inspects it. Renderers are PURE string-builders — the
 * shell wraps the body in the shared canvas, so a renderer returns just the board (no outer
 * full-screen frame).
 */
export interface GameUI<V = unknown> {
  /** The game id (must match the server's game id and the protocol `game`). */
  id: string;
  /** Menu metadata (label + stake style + matchmaking). */
  menu: MenuSpec;
  /** How the session ends (summary / continuous table / settle-then-menu). */
  completion: Completion;

  /** The board/body for the live view as content LINES (no outer frame, no box — the shell
   *  wraps it in the shared canvas, which provides the single titled frame). */
  render(view: V, ctx: GameCtx): string[];
  /** The canvas frame title for the live board (e.g. "Blackjack · room AB12 · ante 50").
   *  Falls back to the static `title` when absent / pre-game. */
  boardTitle?(view: V, ctx: GameCtx): string;
  /** Footer control hints, shown only when it's the player's turn. */
  controls(view: V, ctx: GameCtx): string[];
  /** Map a keypress to a server move, a local UI change (mutate `ctx.ui`), or ignore. */
  onKey(key: Key, view: V, ctx: GameCtx): KeyResult;
  /** Whether it's the viewer's turn to act, given the live view and whether the room is in
   *  the "playing" status. Drives the control hints + whether `onKey` runs. */
  isMyTurn(view: V, playing: boolean): boolean;

  /** Initial per-game local UI state (the four cursor, the craps bet). Defaults to `{}`. */
  initUi?(): GameUiState;
  /** Optional transition animation between two views (RPS reveal, four drop, craps roll),
   *  awaited before the new view is painted. `paint(body)` frames + paints a board string. */
  onView?(prev: V | null, next: V, ctx: GameCtx, paint: (body: string) => void): Promise<void>;
  /** Optional sample views for the menu's side-panel PREVIEW: a short sequence of board states
   *  the category submenu renders (via this same `render`) and cycles on a loop, so the panel
   *  shows the real game in motion. Built from the game's own view shape, so it can't drift from
   *  the live board. One view ⇒ a static preview; several ⇒ a looping animation. */
  preview?(): V[];
  /** Optional pre-rendered preview ANIMATION for the menu panel: full board frames (content
   *  lines) cycled at `ms` per frame — for a game whose preview needs real MOTION that view
   *  snapshots can't express (the roulette wheel spinning to a landing). Preferred over
   *  `preview()` when present; built from the game's own board renderer, so it can't drift. */
  previewFrames?(ctx: GameCtx): { frames: string[][]; ms: number };
  /** A footer status line derived from a fresh view (e.g. blackjack's "★ TWENTY-ONE ★",
   *  craps's "rolled 3 + 4 = 7", RPS's "waiting for opponent…"). Returns null for none. */
  status?(view: V, ctx: GameCtx): string | null;
  /** Continuous tables only: after a settlement lands, should the client STAY seated for the
   *  next round? Called with the final settled view; absent ⇒ always stay (the default table
   *  behaviour). Slots returns `view.busted` — a bust silently re-buys and keeps spinning,
   *  while a voluntary cash-out means "I'm done": leave with the banked chips + a summary. */
  stayAfterSettle?(view: V): boolean;
  /** The pre-game title (e.g. "Blackjack"); the live board carries its own title. */
  title: string;
  /** End-of-match summary body as content LINES (one-shot games; no box — the summary screen
   *  frames it in the canvas titled `title`). The shell resolves `completed` with the final
   *  view; the app shell shows this and offers play-again / menu. The lifetime stats (W–L /
   *  rank / balance) are passed via `ctx.ui.lifetime` when present. */
  summary?(view: V, ctx: GameCtx): string[];
}
