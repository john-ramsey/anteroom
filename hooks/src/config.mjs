// Plugin configuration, read from the environment. The plugin has ONE runtime knob: whether to drop
// the numbers-only "task finished" marker a running Anteroom client toasts on. It's on by default
// (disable the whole plugin to silence it), with a dev escape hatch — ANTEROOM_PING=off.
//
// There are NO desktop notifications and NO "offer to launch": completion is surfaced only IN-APP,
// inside a running Anteroom client that you launch yourself (`anteroom`). That's why there are no
// dialog options / userConfig anymore — the removed watchdog was the only thing they configured.

/**
 * @typedef {Object} PluginConfig
 * @property {boolean} pingOnDone  drop the in-app "finished" marker when a turn ends.
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {PluginConfig}
 */
export function loadConfig(env) {
  const ping = (env.ANTEROOM_PING ?? "").toLowerCase();
  const pingOnDone = !(ping === "off" || ping === "false" || ping === "0" || ping === "no");
  return { pingOnDone };
}
