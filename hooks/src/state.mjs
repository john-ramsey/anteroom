// The tiny bit of cross-event memory the hooks need: when the current turn started, plus a rolling
// duration estimate. It is deliberately all numbers — we never read the transcript, so nothing
// about the conversation is ever written to disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyStats } from "./tracker.mjs";

const STATE_FILE = "state.json";

/**
 * @typedef {Object} TurnState
 * @property {number} startedAt
 * @property {number} [pid]  the AGENT process that owns this turn (see startTurn)
 */
/**
 * @typedef {Object} PluginState
 * @property {TurnState | null} turn
 * @property {import("./tracker.mjs").Stats} stats
 */

/** @returns {PluginState} */
export function emptyState() {
  return { turn: null, stats: emptyStats() };
}

/**
 * Begin a new turn's clock (preserves stats). `pid` is the AGENT process that owns the turn — the
 * hook's parent (`process.ppid`), measured to be the `claude` process itself, with no intervening
 * shell. A watching client uses it to tell "still running" from "the agent went away", which is
 * what stands in for Codex's missing SessionEnd. It is a number, so the markers stay numbers-only.
 * Omitted when unknown; never guessed.
 * @param {PluginState} state @param {number} nowMs @param {number} [pid] @returns {PluginState}
 */
export function startTurn(state, nowMs, pid) {
  const turn = typeof pid === "number" && pid > 0 ? { startedAt: nowMs, pid } : { startedAt: nowMs };
  return { ...state, turn };
}

/**
 * End the turn (keeps stats).
 * @param {PluginState} state @returns {PluginState}
 */
export function endTurn(state) {
  return { ...state, turn: null };
}

// --- persistence (thin fs glue) --------------------------------------------

/**
 * Resolve the marker directory for a given agent. Each agent gets its OWN dir under a STABLE,
 * well-known base (not $CLAUDE_PLUGIN_DATA, which the no-plugin settings.json / Codex recipes don't
 * set) so Claude and Codex never clobber each other and a single Anteroom client can watch both.
 * $ANTEROOM_STATE_DIR pins one exact dir (tests / a single-agent dev setup) and is honored verbatim.
 * The Anteroom client mirrors this layout so one client can watch both agents.
 * @param {Record<string, string | undefined>} env
 * @param {import("./agent.mjs").AgentId} [agent]  which agent's hooks are firing (default "claude")
 * @returns {string}
 */
export function stateDir(env, agent = "claude") {
  if (env.ANTEROOM_STATE_DIR) return env.ANTEROOM_STATE_DIR;
  return join(env.HOME || ".", ".config", "anteroom", "agents", agent);
}

/**
 * Load state, tolerating a missing or corrupt file (a hook must never crash the
 * session over its own scratch file).
 * @param {string} dir @returns {PluginState}
 */
export function loadState(dir) {
  try {
    const raw = readFileSync(join(dir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

/**
 * @param {string} dir @param {PluginState} state
 */
export function saveState(dir, state) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state));
}

const DONE_FILE = "done.json";
/**
 * Write a content-free "turn finished" marker into this agent's dir that a running Anteroom client
 * polls to pop an in-app "<Agent> finished" toast (the client labels it from the dir). Numbers only
 * — no conversation content, consistent with the rest of the plugin. Best-effort.
 * @param {string} dir @param {number} at @param {number} elapsedMs
 */
export function writeDone(dir, at, elapsedMs) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DONE_FILE), JSON.stringify({ at, elapsedMs }));
  } catch {
    // best-effort: never crash a hook over a scratch file
  }
}

const BEAT_FILE = "beat.json";
/**
 * Read the heartbeat marker — the last time a tool ran in the watched session. `null` when
 * absent/corrupt. Lives in its OWN file (never inside state.json): the heartbeat is the
 * highest-frequency write in the plugin, and a whole-state rewrite here could tear the client's
 * 1s poll of state.json or resurrect a turn another hook just ended.
 * @param {string} dir @returns {{at: number} | null}
 */
export function readBeat(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BEAT_FILE), "utf8"));
    return typeof parsed?.at === "number" ? { at: parsed.at } : null;
  } catch {
    return null;
  }
}

/**
 * Write the heartbeat marker, throttled: skipped (returns false) while the existing beat is
 * younger than `minGapMs`, so a rapid tool burst costs one write, not dozens. Numbers only,
 * best-effort — a heartbeat must never crash or slow a hook.
 * @param {string} dir @param {number} at @param {number} [minGapMs]
 * @returns {boolean} whether a write happened
 */
export function writeBeat(dir, at, minGapMs = 0) {
  const prev = readBeat(dir);
  if (prev && at - prev.at < minGapMs) return false;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BEAT_FILE), JSON.stringify({ at }));
    return true;
  } catch {
    return false;
  }
}
