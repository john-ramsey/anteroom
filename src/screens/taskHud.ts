/**
 * The "while your model runs" HUD — a single, content-free status line the client pins on
 * screen while a watched Claude turn is in flight, so you can see your task is still spinning
 * without leaving the game. The whole pitch in one line.
 *
 * HONESTY is the whole point of this module (see taskHud.test.ts):
 *   - Elapsed time is REAL — derived from the plugin's `turn.startedAt` (it writes it to
 *     state.json), or the done marker's `elapsedMs`. Rendered m:ss.
 *   - The spinner + bar are INDETERMINATE. You cannot know how far along an LLM turn is, so we
 *     never draw a "% complete" fill — the bar is a marching shimmer that only means "working".
 *     It always carries an unlit cell so it can't be misread as a full/finished bar.
 *   - The working→done flip is REAL — a NEW done-marker `at` (vs the launch baseline), the same
 *     numbers-only signal `startAgentWatch` already toasts on.
 *
 * Both the live client (index.ts → the per-agent watcher → term.setStatus) and the trailer
 * (scripts/ui-demo.ts) render THIS `hudLine`, so the demo can't drift from what ships. PURE
 * string-builders, semantic palette — no I/O. The fs read of the two markers lives in the
 * caller; `deriveTaskState` is the pure reducer over what it finds.
 */
import { accent, accent2, bold, coinCell, dim, pos } from "../ui.ts";

/** A turn in flight (working — possibly gone quiet, see `stale`) or a fresh finish (done).
 *  `null` means nothing to show. */
export type TaskState =
  | { phase: "working"; startedAt: number; stale?: boolean }
  | { phase: "done"; at: number; elapsedMs: number };

/** The numbers-only markers the plugin writes into the watch dir. */
export interface TaskMarkers {
  /** state.json `turn` — present (with its start time) while a turn is running, else null.
   *  `pid` is the AGENT process that owns the turn (on-prompt stamps `process.ppid`); absent on
   *  markers written by an older plugin. */
  turn: { startedAt: number; pid?: number } | null;
  /** done.json — the last "turn finished" marker, or null if none on disk. */
  done: { at: number; elapsedMs: number } | null;
  /** beat.json — the last tool-activity heartbeat, or null (old plugins / Codex never write it). */
  beat: { at: number } | null;
}

/** A beat this quiet marks the working state stale. Interrupting Claude fires no Stop hook, so
 *  an abandoned turn's marker would spin forever; the heartbeat is the positive evidence that
 *  lets the HUD dim to "stalled?" instead. Generous — tool gaps of minutes are normal thinking. */
const STALL_MS = 4 * 60_000;

/**
 * Reduce the on-disk markers to what the HUD should show. `baselineDoneAt` is the done `at`
 * seen when the client opened, so a stale finish (from before we were watching) doesn't show as
 * a fresh "done". A NEW finish wins over a lingering turn marker.
 *
 * Staleness requires POSITIVE evidence: a beat from THIS turn (`at >= startedAt`) that has gone
 * quiet past STALL_MS. No beat ⇒ unknown ⇒ plain working, forever — old plugins and the Codex
 * recipe never write beats, and a long quiet turn is this product's core case, so absence of
 * evidence must never read as a stall. PURE.
 *
 * `agentAlive` is the liveness backstop for the turn's own agent process, and follows the same
 * evidence rule: `false` (the process is provably gone) clears the turn — this is what stands in
 * for Codex's missing SessionEnd, and it also catches a crash or SIGKILL, which SessionEnd would
 * miss. `true` or `null` (no pid recorded, or a probe we couldn't answer) both mean "keep
 * working". Only an explicit `false` may clear, because a false negative would wipe a live HUD
 * while a false positive merely leaves the pre-existing stall path to catch it.
 */
export function deriveTaskState(
  markers: TaskMarkers,
  baselineDoneAt: number | null,
  now: number,
  agentAlive: boolean | null = null,
): TaskState | null {
  const { turn, done, beat } = markers;
  if (done && done.at !== baselineDoneAt) return { phase: "done", at: done.at, elapsedMs: done.elapsedMs };
  if (turn) {
    if (agentAlive === false) return null; // the agent that owned this turn is gone

    const stale = beat !== null && beat.at >= turn.startedAt && now - beat.at > STALL_MS;
    return stale ? { phase: "working", startedAt: turn.startedAt, stale: true } : { phase: "working", startedAt: turn.startedAt };
  }
  return null;
}

/**
 * Is the agent process that owns a turn still running? `true` alive, `false` provably gone,
 * `null` unknown (no pid on the marker — an older plugin — or a pid that isn't a plausible one).
 *
 * `process.kill(pid, 0)` sends NO signal: signal 0 performs only the kernel's existence and
 * permission checks. Nothing is ever terminated here — the client has no business killing a
 * user's agent; it just asks whether it is still there.
 *
 * The subtlety is that it throws for two very different reasons, and conflating them is the
 * classic bug: `ESRCH` means no such process (dead), while `EPERM` means the process EXISTS but
 * is owned by another user so we may not signal it (alive). Anything that is not a definite
 * ESRCH resolves toward "alive", because a false negative would wipe a live HUD whereas a false
 * positive just leaves the beat-stall path to catch it later.
 *
 * NOTE: pids are recycled by the OS, so a long-dead agent's pid could in principle be reissued to
 * an unrelated process. That yields a false "alive" — i.e. today's behaviour — never a false
 * "dead", so the failure mode stays safe.
 */
export function isAgentAlive(pid: number | undefined): boolean | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true; // exists, and we may signal it
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

/** A millisecond span as a compact clock: `0:07`, `1:42`, `10:00`, `1:01:01`. PURE. */
function clock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const BAR_W = 8;
const WINDOW = 3; // lit cells in the marching window — always < BAR_W so an unlit cell remains
/**
 * An INDETERMINATE activity bar: a `WINDOW`-wide block of lit cells marching across `BAR_W`
 * cells, positioned by `tick`. It signals "working", NOT progress — by construction it always
 * leaves an unlit cell, so it can never look like a finished 100% fill. Lit cells carry the
 * agent's tint so the spinner and the bar on a line always match. PURE.
 */
function shimmerBar(tick: number, tint: (s: string) => string = accent): string {
  const start = ((tick % BAR_W) + BAR_W) % BAR_W;
  let out = "";
  for (let i = 0; i < BAR_W; i++) {
    const lit = (i - start + BAR_W) % BAR_W < WINDOW;
    out += lit ? tint("▰") : dim("▱");
  }
  return out;
}

/**
 * Which of the theme's two accents identifies an agent. With Claude and Codex both wired the HUD
 * stacks a line each, so they need to be tellable apart at a glance rather than by reading the
 * label: Claude takes the primary accent, Codex the secondary (the default theme is named
 * "orange-blue" for exactly these two). Anything else falls back to the primary.
 *
 * Returns a SEMANTIC palette fn, never a hex — a user on the cyan or neon theme gets two
 * distinguishable colours from their own palette instead of orange and blue forced into it. PURE.
 */
export function agentTint(label: string): (s: string) => string {
  return label === "codex" ? accent2 : accent;
}

/**
 * The HUD line for a task state: while working, a spinner + the marching bar + the live clock;
 * gone quiet (`stale`), a dim motionless "stalled?" — motion means working, so a stalled line
 * holds still; once done, a green "✓ claude finished · m:ss". `now` drives the live elapsed;
 * `tick` drives the spinner/bar animation. `label` names the agent ("claude" / "codex"), so one
 * client can pin a stacked line per running agent. PURE — the caller owns the timer and where it
 * draws this. */
export function hudLine(state: TaskState, now: number, tick: number, label = "claude"): string {
  // "done" is green and "stalled" is dim on purpose: those colours carry STATUS meaning, and
  // overriding them with an agent tint would trade a real signal for a branding one.
  if (state.phase === "done") {
    return `${pos("✓")}  ${pos(bold(`${label} finished`))}  ${dim(`· ${clock(state.elapsedMs)}`)}`;
  }
  if (state.stale) {
    return `${dim("◦")}  ${dim(`${label} — stalled?`)}  ${dim(`· ${clock(now - state.startedAt)}`)}`;
  }
  const tint = agentTint(label);
  return `${tint(coinCell(tick))}  ${dim(label)}  ${shimmerBar(tick, tint)}  ${dim(clock(now - state.startedAt))}`;
}
