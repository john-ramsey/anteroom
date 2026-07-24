# Anteroom — Claude Code plugin

Play Anteroom while a long Claude task runs, and get an in-app ping when it finishes.

## What it does

- **Ping when done, only while you're playing.** When Claude finishes a turn (`Stop` +
  `Notification:idle_prompt` hooks), the plugin drops a content-free marker that a *running*
  Anteroom client reads to ping "Claude finished" **in-app**. The ping lives entirely inside the
  client, so it never fires from a terminal/editor where you aren't actually playing.
- **A live task HUD.** Each prompt stamps a start timestamp; a running Anteroom client reads it to
  pin a top-right HUD (a spinner, an indeterminate bar, a real m:ss clock) while the turn is in
  flight, so you can see the task is still going without leaving the game. There is **no watchdog and
  no "offer to launch"**: you launch `anteroom` yourself and it watches automatically, with nothing
  to configure.
- **Zero added tokens.** The plugin is *only* event hooks, no slash commands. A slash command is a
  prompt routed through the model (a turn plus tokens, and it queues behind a running turn), so it's
  the wrong primitive; the hooks do everything with no model involvement at all.
- **Claude and/or Codex, side by side.** Each hook is tagged with its agent id, so Claude and Codex
  write to separate marker dirs (`~/.config/anteroom/agents/<agent>/`) and one running `anteroom`
  pings for whichever finishes.

## Privacy — no agent data is read or stored

This is a hard design constraint, enforced by construction, not by promise:

- The hook scripts **never read the hook payload**: not the prompt, not `transcript_path`, nothing
  about the conversation. They act only on the *fact* that an event fired plus a timestamp.
- The only persisted state is **numbers** (a start timestamp, turn durations, a heartbeat), under a
  stable per-agent dir (`~/.config/anteroom/agents/<agent>/`).
- Nothing is sent off the machine.

## Configuration — none

There are no settings. The plugin's one behavior (drop the in-app "finished" marker) is always on
while the plugin is enabled; **disable the plugin** to silence it. For dev only, `ANTEROOM_PING=off`
skips the marker and `ANTEROOM_STATE_DIR` pins the dir (exported env vars, never dialog fields).

## How it works

```
UserPromptSubmit ─▶ on-prompt.mjs        stamp the turn's start time (the HUD's clock)
Stop / Notification ─▶ on-idle.mjs       record elapsed, drop the in-app "finished" marker, end turn
PostToolUse ─▶ on-tool.mjs               heartbeat: beat.json {at}, ≥5s apart (async, stdin ignored)
SessionEnd  ─▶ on-session-end.mjs        quit the agent → clear the turn (no "done" ping, no sample)
```

Each command carries its agent id as a trailing arg (`… on-prompt.mjs claude`), so every marker lands
in that agent's own dir and Claude and Codex never clobber each other.

**Why the heartbeat:** interrupting the agent (esc) or killing the process fires no `Stop` hook, so
the turn marker would show "working" in the client's HUD forever. The heartbeat gives the HUD positive
evidence: a beat that goes quiet for ~4 min dims the HUD to a motionless `claude — stalled?`.
**Absence of a beat never means stalled** — the Codex recipe (no `PostToolUse` equivalent) simply
never writes one, and a long quiet turn is the normal case. Like every marker here, `beat.json` is
numbers-only; the `PostToolUse` payload (which carries conversation content) is never read.

Known limit (pre-existing): an agent's state dir is global to that agent, so with several concurrent
Claude sessions the newest prompt owns the stopwatch and any session's Stop/SessionEnd ends it — the
HUD tracks "a" Claude session, not each one. Acceptable for a content-free convenience marker.

## Development

Pure logic (`src/*.mjs`, JSDoc-typed plain ESM so it runs under bare `node` at hook time) is covered
test-first; the fs/process glue (`scripts/*.mjs`) is thin and validated by the manifest/structure
test plus a smoke run.

```bash
npx vitest run --project plugin       # plugin suite only (or `npm test` for the whole repo)
npm run typecheck -w @anteroom/plugin
```
