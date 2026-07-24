// PostToolUse hook: drop a numbers-only heartbeat (beat.json {at}) so a watching Anteroom
// client can tell a long-but-alive turn from an interrupted one that will never Stop — the HUD
// dims to "stalled?" only on positive evidence (a beat that went quiet), never on silence alone.
// Throttled to one write per 5s so a rapid tool burst costs one fs write. (Claude Code only; Codex
// has no PostToolUse equivalent, so its recipe never beats and the HUD treats absence as unknown.)
//
// argv[2] is the agent id ("claude" | "codex"). PRIVACY: the PostToolUse payload carries tool
// inputs/outputs (conversation content) — this script never reads that payload; the only thing
// recorded is a timestamp. Nothing is printed.

import { agentFromArgv } from "../src/agent.mjs";
import { stateDir, writeBeat } from "../src/state.mjs";

const MIN_GAP_MS = 5_000;
writeBeat(stateDir(process.env, agentFromArgv()), Date.now(), MIN_GAP_MS);

process.exit(0);
