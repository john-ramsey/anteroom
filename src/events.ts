/**
 * The client's ONE sink for `ServerEvent`s, shared by both carriers: the `/me` response the menu
 * reads, and the `event` frames a session receives at a table. Same envelope, same rendering, so
 * a player hears a thing once and hears it the same way wherever they happen to be standing.
 *
 * Two rules live here, and both are the reason it isn't written twice:
 *
 *  - Render the TEXT, never branch on `kind`. A build that has never heard of an event still
 *    tells the player what happened, instead of swallowing it.
 *  - Show an id once. Delivery is at-least-once by design (the server re-hands an event until a
 *    client acks it), and the seen-set is process-wide, so an event that arrives at a table and
 *    again on the next `/me` is still only announced once.
 */
import type { Terminal } from "./terminal.ts";
import { sanitizeText } from "./ui.ts";
import type { ServerEvent } from "@anteroom/protocol";

/** Ids already announced to the human at this terminal, for as long as the client runs. */
const shown = new Set<string>();

/** Forget what's been shown. For tests — one process means one human, so nothing else needs it. */
export function resetShownEvents(): void {
  shown.clear();
}

/**
 * Announce any of `events` the player hasn't already been told about. Returns the ids that were
 * DELIVERED to the player (new ones), which is what a caller acknowledges to the server.
 *
 * `text` is server-supplied prose being painted into a terminal, so it is stripped of control
 * bytes here at the boundary (`renderToast` strips again on the way out — this is not the place
 * to rely on someone else's diligence).
 */
export function showEvents(term: Terminal, events: readonly ServerEvent[]): string[] {
  const delivered: string[] = [];
  for (const ev of events) {
    if (shown.has(ev.id)) continue;
    shown.add(ev.id);
    term.toast(sanitizeText(ev.text), { kind: "info" });
    delivered.push(ev.id);
  }
  return delivered;
}
