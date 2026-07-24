// UserPromptSubmit hook: start THIS turn's stopwatch, then exit immediately (never delays input).
// The only thing recorded is a timestamp; a running Anteroom client reads it to show an in-app
// "task running" HUD. There is no desktop notification and no "offer to launch" — both removed.
// We print NOTHING to stdout (a UserPromptSubmit hook's stdout would be injected into the prompt).
//
// argv[2] is the agent id ("claude" | "codex"), wired by the hook config so each agent writes to its
// OWN marker dir and one client can watch both (see src/agent.mjs, src/state.mjs).
//
// PRIVACY: we deliberately do NOT read the hook's stdin payload — not the prompt, not
// transcript_path. Nothing about the conversation is read, stored, or transmitted.

import { agentFromArgv } from "../src/agent.mjs";
import { loadState, saveState, startTurn, stateDir } from "../src/state.mjs";

const dir = stateDir(process.env, agentFromArgv());
// process.ppid is the AGENT process (measured: the `claude` process, no shell layer).
saveState(dir, startTurn(loadState(dir), Date.now(), process.ppid));

process.exit(0);
