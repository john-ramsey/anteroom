/**
 * Shared roster row for a vs-house multiplayer table (craps, roulette): ready mark · name ·
 * stack · bets. Everything except how a single bet is labelled is identical between the two, so
 * the per-game part is just the `betLabel` callback. Generic over the game's own bet type `B`. PURE.
 */
import { accent, accent2, bold, dim, fmtChips, padEndVisible, padStartVisible, pos, truncVisible } from "../../ui.ts";

interface RosterView<B> {
  you: string;
  handOver: boolean;
  seats: Record<string, { stack: number; ready: boolean; bets: B[] }>;
}

export function seatRosterRow<B>(
  view: RosterView<B>,
  p: string,
  nameFor: (id: string) => string,
  betLabel: (b: B) => string,
  width: number,
): string {
  const seat = view.seats[p]!;
  const mark = view.handOver ? " " : seat.ready ? pos("✓") : dim("·");
  const name = p === view.you ? accent(bold(nameFor(p))) : accent2(nameFor(p));
  const stack = `${bold(fmtChips(seat.stack))} ${dim("chips")}`;
  const bets = seat.bets.length > 0 ? seat.bets.map(betLabel).join(dim(" · ")) : dim("—");
  const row = `  ${mark} ${padEndVisible(name, 14)} ${padStartVisible(stack, 12)}   ${bets}`;
  // Pad short rows to `width` (so they align under the centred board) and clamp long ones —
  // a many-bet or long-name seat must never overrun its budget and break the canvas box.
  return truncVisible(padEndVisible(row, width), width);
}
