// "Claude is done" handler — wired to BOTH Stop and Notification(idle_prompt) so it fires
// whichever signal the runtime emits. Idempotent: the first one to run handles the turn
// (records elapsed time, pings, ends the turn); the other finds no active turn and no-ops.
//
// PRIVACY: like on-prompt, we ignore the hook's stdin entirely. We compute elapsed time
// from our own start timestamp and emit a fixed, content-free message — never any text
// from the conversation.

import { agentFromArgv } from "../src/agent.mjs";
import { loadConfig } from "../src/config.mjs";
import { endTurn, loadState, saveState, stateDir, writeDone } from "../src/state.mjs";
import { recordDuration } from "../src/tracker.mjs";

const env = process.env;
const cfg = loadConfig(env);
const dir = stateDir(env, agentFromArgv());
const state = loadState(dir);

// Idempotent: no active turn means a sibling signal already handled this one.
if (state.turn) {
  const elapsed = Date.now() - state.turn.startedAt;
  const stats = recordDuration(state.stats, elapsed);
  saveState(dir, endTurn({ ...state, stats }));

  if (cfg.pingOnDone) {
    // No desktop notification of any kind: we ONLY drop a content-free marker into THIS agent's dir
    // that a running Anteroom client reads to ping "<Agent> finished" IN-APP. So completion is
    // surfaced only when you're actually playing Anteroom, and it's labeled by which agent finished.
    writeDone(dir, Date.now(), elapsed);
  }
}

process.exit(0);
