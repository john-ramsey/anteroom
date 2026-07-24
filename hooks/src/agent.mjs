// Which agent's hooks are firing, taken from the hook command's trailing arg
// (`… /on-prompt.mjs <agent>`). The Claude Code plugin (hooks/hooks.json) tags its hooks "claude";
// `anteroom setup`'s generated Codex config tags them "codex". Each agent therefore writes to its
// OWN marker dir (see state.mjs `stateDir`), so Claude and Codex never clobber each other and one
// Anteroom client can watch both. An un-tagged/legacy hook defaults to "claude".

/** @typedef {"claude" | "codex"} AgentId */

/**
 * @param {string[]} [argv]  defaults to process.argv
 * @returns {AgentId}
 */
export function agentFromArgv(argv = process.argv) {
  return argv[2] === "codex" ? "codex" : "claude";
}
