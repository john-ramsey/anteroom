/**
 * The client's standing question to the server: where do I stand, and is there anything you need
 * to tell me? One `/me` round trip, asked ahead of the moment it's needed and taken delivery of
 * when the player is somewhere they can act on the answer.
 *
 * This is a GATE rather than a call, because the two halves happen at different times: `ask()`
 * fires the request early (it overlaps the intro, or a summary screen), and `absorb()` collects it
 * at a point where a message can be shown and a stake can be sized. It lived as a closure inside
 * `main()` and grew a bug that shape makes easy: the paths that launch straight into a game from
 * flags never reached the absorb, so a broke player was launched into a table with the recovery
 * still in flight (or, off a TTY, never asked for at all). A module can be tested; a closure inside
 * a 200-line `main()` cannot.
 */
import { showEvents } from "./events.ts";
import { fetchMe, nextAcks, type MeResult } from "./net.ts";
import type { Terminal } from "./terminal.ts";

/** What `/me` needs to name the caller: a token if they have one, a display name if they don't. */
export interface MeIdentity {
  token?: string;
  name: string;
}

/** How the gate reaches the server. Injected so the wiring can be tested without a network. */
export type MeFetch = (server: string, identity: MeIdentity, ack?: string[]) => Promise<MeResult>;

export interface MeGate {
  /** Fire a `/me`, carrying anything still owed an acknowledgement. Replaces any in-flight ask. */
  ask(identity: MeIdentity): void;
  /** Take delivery: show what the server said, ack it, and update what the player can spend.
   *  Idempotent and safe to call anywhere — with nothing in flight it does nothing. */
  absorb(): Promise<void>;
  /**
   * Chips this player can actually put up right now, or null when we don't know. Null must stay
   * null: a guessed figure would size a real stake, and an outage must not block play either, so
   * the caller falls back to the table's own cap and lets the server have the last word.
   *
   * AVAILABLE, not balance: a hold left open by a session that died mid-hand is still in `balance`
   * but cannot be reserved, and a prompt offering it produces exactly the refusal all this exists
   * to remove. (The server's top-up keys off `balance` instead, because "am I broke" and "what can
   * I put up right now" are different questions with different answers.)
   */
  readonly spendable: number | null;
  /** Drop the figure — a sign-out means the next answer is about a different wallet, or none. */
  forget(): void;
}

export function createMeGate(term: Terminal, server: string, call: MeFetch = fetchMe): MeGate {
  let pending: Promise<MeResult> | null = null;
  /** Ids the player has been shown, riding the NEXT request. Until the server hears one back it
   *  keeps handing that event over, so a message about someone's own chips can't be lost to a
   *  response that never arrived. */
  let acks: string[] = [];
  let spendable: number | null = null;

  return {
    get spendable() {
      return spendable;
    },
    ask(identity: MeIdentity): void {
      pending = call(server, identity, acks);
    },
    async absorb(): Promise<void> {
      if (!pending) return;
      const me = await pending;
      pending = null;
      // The same sink a session uses (events.ts), which is what makes an event announced once
      // however it arrived. Off a TTY `term.toast` logs the line instead of overlaying it, so a
      // piped/CI launch still tells the player their chips moved.
      showEvents(term, (me.ok && me.events) || []);
      acks = nextAcks(acks, me);
      spendable = me.ok ? me.snapshot.available : null;
    },
    forget(): void {
      spendable = null;
    },
  };
}
