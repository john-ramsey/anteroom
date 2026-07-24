// A rolling estimate of how long turns take, built ONLY from elapsed-time samples.
// This is the honest stand-in for the (impossible) upfront estimate: we can't predict
// a task's length, but we can remember how long past ones took. The stored shape is
// three numbers — no prompt, no response, nothing about the conversation.

/**
 * @typedef {Object} Stats
 * @property {number} samples  how many turns we've timed.
 * @property {number} avgMs    running mean turn duration.
 * @property {number} lastMs   the most recent turn's duration.
 */

/** @returns {Stats} */
export function emptyStats() {
  return { samples: 0, avgMs: 0, lastMs: 0 };
}

/**
 * Fold a new elapsed-time sample into the running average. Invalid samples
 * (non-finite or negative) are ignored so a bad clock can't poison the estimate.
 * @param {Stats} stats
 * @param {number} ms
 * @returns {Stats}
 */
export function recordDuration(stats, ms) {
  if (!Number.isFinite(ms) || ms < 0) return stats;
  const samples = stats.samples + 1;
  const avgMs = Math.round((stats.avgMs * stats.samples + ms) / samples);
  return { samples, avgMs, lastMs: ms };
}

/**
 * The best current estimate, or null until we've timed at least one turn.
 * @param {Stats} stats
 * @returns {number | null}
 */
export function estimateMs(stats) {
  return stats.samples > 0 ? stats.avgMs : null;
}
