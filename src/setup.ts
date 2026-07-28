/**
 * `anteroom setup` — wire the zero-token "play while you wait" hooks into the agents you have
 * (Claude Code and/or Codex). The client is the hub: it knows where the hook scripts live and stamps
 * the right config for each agent.
 *
 * Safe by default: it PRINTS the exact config it would add (a dry run). `--write` applies BOTH
 * agents' changes as non-destructive JSON merges, each with a `.bak` backup: Claude Code's
 * `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`. (An earlier version could only print
 * a `config.toml` snippet for Codex to paste, because editing TOML in place without a parser risks
 * clobbering existing config. Codex reads a user-level `hooks.json` in the same JSON schema Claude
 * uses, so there is nothing left to paste.)
 *
 * Hook-script resolution (in priority order): `ANTEROOM_HOOKS_DIR` if set; else the scripts BUNDLED
 * next to the published bin (`<pkg>/hooks/scripts`, shipped in `files`); else, when running from a
 * source checkout, the sibling plugin package's `scripts` dir.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Absolute path to the directory holding the hook scripts (on-prompt.mjs, on-idle.mjs, …). `baseDir`
 *  is the resolver's anchor (the bin's dir in a published install, this file's dir in dev) — injected
 *  for tests; defaults to this module's location. */
export function resolveHooksDir(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  if (env.ANTEROOM_HOOKS_DIR) return resolve(env.ANTEROOM_HOOKS_DIR);
  // Published: the client bundles the hook scripts beside the bin at <pkg>/hooks/scripts (baseDir is
  // <pkg>/dist there, so ".." lands on the package root).
  const bundled = resolve(baseDir, "..", "hooks", "scripts");
  if (existsSync(join(bundled, "on-prompt.mjs"))) return bundled;
  // Source checkout: the sibling plugin package's scripts dir (baseDir is the client's src).
  return resolve(baseDir, "..", "..", "plugin", "scripts");
}

const q = (s: string): string => `node "${s}"`;

/** The `hooks` object to merge into a Claude Code settings.json (start, end, idle, quit,
 *  heartbeat). Mirrors the plugin's hooks/hooks.json — keep the two in sync. Each command is tagged
 *  with the agent id ("claude") so its markers land in that agent's own dir (see the Codex recipe,
 *  which tags "codex") and one client can watch both without collision. */
export function claudeHooks(hooksDir: string): Record<string, unknown> {
  const cmd = (script: string) => ({ type: "command", command: `${q(join(hooksDir, script))} claude` });
  return {
    UserPromptSubmit: [{ hooks: [cmd("on-prompt.mjs")] }],
    Stop: [{ hooks: [cmd("on-idle.mjs")] }],
    Notification: [{ matcher: "idle_prompt", hooks: [cmd("on-idle.mjs")] }],
    // Quitting Claude clears the stopwatch (no fake "finished" ping) — the HUD never spins forever.
    SessionEnd: [{ hooks: [cmd("on-session-end.mjs")] }],
    // Numbers-only heartbeat; async so the tool loop never waits on it. (Codex has no PostToolUse
    // equivalent — its recipe simply never beats, and the HUD treats absence as unknown, not stalled.)
    PostToolUse: [{ hooks: [{ ...cmd("on-tool.mjs"), async: true }] }],
  };
}

/** The `hooks` object for a Codex user-level `~/.codex/hooks.json` — the SAME JSON schema Claude
 *  Code uses, so this mirrors `claudeHooks` with two differences:
 *    - every command is tagged "codex" (its markers land in Codex's own dir, never clobbering
 *      Claude's), and
 *    - Codex's lifecycle has NO SessionEnd and no Notification:idle_prompt, so those two aren't
 *      wired. The PostToolUse heartbeat is what covers an abandoned turn instead — the client
 *      dims the HUD to "stalled?" on a beat that went quiet (see screens/taskHud.ts).
 *  This replaced a print-only config.toml snippet: TOML can't be safely auto-edited without a
 *  parser, but this file is plain JSON, so setup can merge it non-destructively. */
export function codexHooks(hooksDir: string): Record<string, unknown> {
  const cmd = (script: string) => ({ type: "command", command: `${q(join(hooksDir, script))} codex` });
  return {
    UserPromptSubmit: [{ hooks: [cmd("on-prompt.mjs")] }],
    Stop: [{ hooks: [cmd("on-idle.mjs")] }],
    PostToolUse: [{ hooks: [cmd("on-tool.mjs")] }],
  };
}

/** Fold our hook entries into whatever the user already has, per event. Never drops or rewrites a
 *  prior entry: ours are APPENDED alongside. An event that already mentions Anteroom is left
 *  untouched, which is what makes re-running setup idempotent. Shared by both agents — the Claude
 *  and Codex files differ only in where this object lives, not in how it merges. */
function mergeHookEvents(
  curHooks: Record<string, unknown[]>,
  ours: Record<string, unknown>,
): { merged: Record<string, unknown[]>; warnings: string[] } {
  const warnings: string[] = [];
  const merged: Record<string, unknown[]> = { ...curHooks };
  for (const [event, entries] of Object.entries(ours)) {
    const prior = Array.isArray(curHooks[event]) ? curHooks[event] : [];
    const already = JSON.stringify(prior).includes("anteroom") || JSON.stringify(prior).includes("on-prompt.mjs");
    merged[event] = already ? prior : [...prior, ...(entries as unknown[])];
    if (already) warnings.push(`hooks.${event} already references Anteroom — left as-is`);
  }
  return { merged, warnings };
}

/** Merge our hooks into an existing settings object, non-destructively (preserves unrelated hooks +
 *  everything else). Returns the new object plus warnings for anything we left as-is. */
export function mergeClaudeSettings(
  existing: Record<string, unknown>,
  hooksDir: string,
): { settings: Record<string, unknown>; warnings: string[] } {
  const { merged, warnings } = mergeHookEvents(
    (existing.hooks ?? {}) as Record<string, unknown[]>,
    claudeHooks(hooksDir),
  );
  return { settings: { ...existing, hooks: merged }, warnings };
}

/** Merge our hooks into an existing `~/.codex/hooks.json`, non-destructively. Same contract as
 *  `mergeClaudeSettings`, only the file is dedicated to hooks rather than all settings — so an
 *  unrelated user hook (a SessionStart script, say) survives untouched. */
export function mergeCodexHooks(
  existing: Record<string, unknown>,
  hooksDir: string,
): { file: Record<string, unknown>; warnings: string[] } {
  const { merged, warnings } = mergeHookEvents(
    (existing.hooks ?? {}) as Record<string, unknown[]>,
    codexHooks(hooksDir),
  );
  return { file: { ...existing, hooks: merged }, warnings };
}

/** Is `bin` resolvable on PATH? A read-only probe — it resolves the command (like `which`), it does
 *  NOT run it. Standard, non-invasive install detection. `bin` is a fixed literal (no injection). */
export function onPath(bin: string): boolean {
  try {
    return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** The Claude Code config dir (honoring the CLAUDE_CONFIG_DIR override). */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}
/** The Codex config dir (honoring the CODEX_HOME override). */
export function codexDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

/** Detect installed agents: a present config dir OR the CLI on PATH (so we still find an install
 *  that hasn't created its config dir yet, or uses a custom config dir). `probe` is injectable for
 *  tests; it defaults to a read-only PATH lookup. */
export function detectAgents(
  env: NodeJS.ProcessEnv = process.env,
  probe: (bin: string) => boolean = onPath,
): { claude: boolean; codex: boolean } {
  return {
    claude: existsSync(claudeDir(env)) || probe("claude"),
    codex: existsSync(codexDir(env)) || probe("codex"),
  };
}

/* ---------------------------------------------------------------- CLI ----- */

const log = (s = ""): void => console.log(s);

/** Injectable I/O for the interactive apply prompt. `confirm` present ⇒ ask before each change;
 *  absent ⇒ non-interactive (pure dry-run). Tests pass a fake `confirm`; the default reads a TTY. */
export interface SetupIO {
  confirm?: (question: string) => Promise<boolean>;
}

/** Ask a y/N question on the real terminal (one readline per prompt, closed after). */
function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/** On a real TTY, setup asks before each change; piped / non-TTY (CI, the Homebrew formula's
 *  `anteroom setup 2>&1` test) stays a pure dry-run so it never blocks on input. */
function defaultSetupIo(): SetupIO {
  return { confirm: process.stdin.isTTY && process.stdout.isTTY ? ttyConfirm : undefined };
}

/** Apply `content` to `path` (backing up any existing file) or just preview it, per the mode.
 *  Returns whether it wrote. `--write` writes straight off; otherwise it previews and, if a
 *  `confirm` is available and the user says yes, writes. */
async function decideWrite(
  label: string,
  path: string,
  content: Record<string, unknown>,
  preview: Record<string, unknown>,
  forceWrite: boolean,
  confirm?: (q: string) => Promise<boolean>,
): Promise<boolean> {
  if (!forceWrite) {
    log("  would add:");
    log(indent(JSON.stringify(preview, null, 2)));
    if (!confirm || !(await confirm(`  Apply these hooks to ${label}? [y/N] `))) return false;
  }
  if (existsSync(path)) backupFile(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n");
  log(`  ✓ wrote hooks${existsSync(`${path}.bak`) ? ` (backup: ${path}.bak)` : ""}`);
  return true;
}

export async function runSetup(argv: string[], io: SetupIO = defaultSetupIo()): Promise<void> {
  const forceWrite = argv.includes("--write") || argv.includes("--yes");
  const forceDry = argv.includes("--dry-run");
  // Prompt only when neither flag forces the outcome AND we have a way to ask (a TTY / injected io).
  const confirm = !forceWrite && !forceDry && typeof io.confirm === "function" ? io.confirm : undefined;
  const hooksDir = resolveHooksDir();
  const agents = detectAgents();
  const wantClaude = argv.includes("--claude") || (!argv.includes("--codex") && agents.claude);
  const wantCodex = argv.includes("--codex") || (!argv.includes("--claude") && agents.codex);

  log("Anteroom setup — wires the zero-token 'play while you wait' hooks into your agent(s).");
  log(`  hook scripts: ${hooksDir}`);
  if (!existsSync(join(hooksDir, "on-prompt.mjs"))) {
    log(`  ⚠ hook scripts not found there. Set ANTEROOM_HOOKS_DIR to the plugin's scripts/ dir.`);
  }
  log(
    forceWrite
      ? "  mode: WRITE (applying changes)"
      : confirm
        ? "  mode: interactive — you'll be asked before each change"
        : "  mode: dry run (pass --write to apply)",
  );
  log();

  if (wantClaude) {
    const path = join(claudeDir(), "settings.json");
    const { settings, warnings } = mergeClaudeSettings(readJson(path), hooksDir);
    log("── Claude Code ───────────────────────────");
    log(`  file: ${path}`);
    for (const w of warnings) log(`  • ${w}`);
    await decideWrite("Claude Code", path, settings, { hooks: claudeHooks(hooksDir) }, forceWrite, confirm);
    log();
  }

  if (wantCodex) {
    const path = join(codexDir(), "hooks.json");
    const { file, warnings } = mergeCodexHooks(readJson(path), hooksDir);
    log("── Codex ─────────────────────────────────");
    log(`  file: ${path}`);
    for (const w of warnings) log(`  • ${w}`);
    const wrote = await decideWrite("Codex", path, file, { hooks: codexHooks(hooksDir) }, forceWrite, confirm);
    // Codex refuses to run a hook it hasn't been told to trust (see `--dangerously-bypass-hook-
    // trust`), so unlike Claude the write alone isn't enough — the first interactive run asks.
    if (wrote) log("  → next: start Codex once and approve the hooks when it asks (Codex gates hook trust).");
    log();
  }

  if (!wantClaude && !wantCodex) {
    log("No agent detected (~/.claude or ~/.codex). Pass --claude or --codex to force one.");
  } else {
    log("No desktop notifications: just run `anteroom`. It shows a live task HUD and pings you");
    log("in-app when Claude and/or Codex finishes (watching both at once when both are set up).");
    log("Restart the agent (or /reload-plugins) to pick up the hooks.");
  }
}

/** Back up `path` to `${path}.bak`, copying the exact bytes and preserving the source's permissions.
 *  settings.json can hold secrets (MCP env vars, tokens, hook commands), so a 0600 original must not
 *  leak into a world-readable backup: we stat the source for its mode, pass it to writeFileSync, then
 *  chmod to force it exactly (writeFileSync's mode is umask-masked, and a pre-existing .bak keeps its
 *  old mode otherwise). Copying raw bytes also keeps the backup faithful even if the file isn't JSON. */
export function backupFile(path: string): string {
  const bak = `${path}.bak`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(bak, readFileSync(path), { mode });
  chmodSync(bak, mode);
  return bak;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const indent = (s: string): string => s.split("\n").map((l) => `    ${l}`).join("\n");
