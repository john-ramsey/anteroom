// SessionEnd hook: the user quit the agent — stop this agent's stopwatch so a watching Anteroom
// client's HUD doesn't show it "working" forever. Quit ≠ finished: we clear the turn but
// deliberately write NO done marker (no "finished" ping for a session the user closed) and record
// NO duration sample (a quit mid-turn would skew the long-turn stats the tracker keeps).
//
// argv[2] is the agent id ("claude" | "codex"); like every hook here, stdin is ignored and nothing
// is printed.

import { agentFromArgv } from "../src/agent.mjs";
import { endTurn, loadState, saveState, stateDir } from "../src/state.mjs";

const dir = stateDir(process.env, agentFromArgv());
const state = loadState(dir);
if (state.turn) saveState(dir, endTurn(state));

process.exit(0);
