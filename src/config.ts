/**
 * Default endpoint resolution for the client.
 *
 * Precedence:  runtime env var  >  build-baked value  >  dev fallback
 * (`--client-id` still overrides in parseArgs; there is no `--server` flag — ANTEROOM_SERVER
 * is the only way to aim the client elsewhere.)
 *
 * The build-baked value is injected by esbuild `--define` when producing the published
 * `anteroom` bin (see build.mjs), so `npx anteroom` points at prod out of the box while
 * `tsx src/index.ts` (no define) stays on localhost. Kept pure + side-effect-free so the
 * precedence is unit-tested without touching the real `process.env` or a bundler.
 */

import { join } from "node:path";

/** Where local `npm run play` (tsx, nothing baked) connects. */
export const DEV_SERVER = "ws://localhost:8787";

type Env = Record<string, string | undefined>;

/** One agent's marker directory: `id` labels its in-app "finished" ping ("claude" → "Claude"). */
export interface AgentWatch {
  id: string;
  dir: string;
}

/**
 * The per-agent marker dirs the client watches for "task running" / "task finished" pings, with
 * ZERO configuration — a bare `anteroom` discovers them. Each agent writes under
 * `~/.config/anteroom/agents/<id>/`, so Claude and Codex never collide and one client can watch
 * both. `$ANTEROOM_STATE_DIR` pins a single dir (tests / a single-agent dev setup). PURE — the
 * caller filters to the dirs that actually exist.
 */
export function agentWatchDirs(env: Env): AgentWatch[] {
  if (env.ANTEROOM_STATE_DIR) return [{ id: "claude", dir: env.ANTEROOM_STATE_DIR }];
  const base = join(env.HOME || ".", ".config", "anteroom", "agents");
  return [
    { id: "claude", dir: join(base, "claude") },
    { id: "codex", dir: join(base, "codex") },
  ];
}

/** Default WebSocket/HTTP server URL. Empty env values are ignored (treated as unset). */
export function resolveServer(env: Env, baked: string | undefined): string {
  return env.ANTEROOM_SERVER || baked || DEV_SERVER;
}

/** Default GitHub OAuth client id (public; device flow). Undefined when neither is set. */
export function resolveClientId(env: Env, baked: string | undefined): string | undefined {
  return env.ANTEROOM_GITHUB_CLIENT_ID || baked || undefined;
}
