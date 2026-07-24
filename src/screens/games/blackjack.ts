/**
 * Blackjack — a self-contained client `GameUI` module.
 *
 * A CONTINUOUS table (stays seated across rounds; the shell only leaves on q/disconnect),
 * intrinsic vs the dealer. Moved here from ui.ts / session.ts: the big/compact table
 * renderers, the deal animation, the settings sample board, the 21 status line, and the
 * [h]it/[s]tand input. The layout preference is a shared app setting (ui.getLayout()).
 */
import {
  accent,
  accent2,
  animateFrames,
  bigHandLines,
  bold,
  box,
  bracketHand,
  center,
  dim,
  getLayout,
  neg,
  padEndVisible,
  pos,
  rainbow,
  visibleLen,
  warn,
  type Card,
} from "../../ui.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, KeyResult } from "./types.ts";

export interface BjHand {
  cards: Card[];
  value: number;
  bust: boolean;
  blackjack: boolean;
  outcome: "blackjack" | "win" | "push" | "lose" | null;
}

export interface BjView {
  you: string;
  players: string[];
  ante: number;
  /** Each seat's own bet this hand (per-player stakes) — shown beside the seat. Optional so older
   *  view shapes / the settings sample still type-check. */
  antes?: Record<string, number>;
  hands: Record<string, BjHand>;
  dealer: { cards: Card[]; value: number; hidden: boolean; bust: boolean };
  turn: string | null;
  yourTurn: boolean;
  complete: boolean;
  winner: string | null;
}

const DEALER_KEY = "@dealer";

function outcomeLabel(outcome: NonNullable<BjHand["outcome"]>, delta: number | null): string {
  const d = delta === null ? "" : delta > 0 ? ` +${delta}` : delta < 0 ? ` ${delta}` : "";
  switch (outcome) {
    case "blackjack":
      return pos(bold(`BLACKJACK 3:2${d}`));
    case "win":
      return pos(`WIN${d}`);
    case "push":
      return warn(`PUSH${d}`);
    case "lose":
      return neg(`LOSE${d}`);
  }
}

/** A seat's header line: label, hand value, and a trailing note (turn / outcome). */
function bjSeatHeader(label: string, value: string, trailing: string): string {
  return trailing ? `${label}   ${value}   ${trailing}` : `${label}   ${value}`;
}

function bjTitle(v: BjView, room: string): string {
  return v.ante > 0 ? `Blackjack  ·  room ${room}  ·  ante ${v.ante}` : `Blackjack  ·  room ${room}`;
}
function bjValue(h: BjHand): string {
  return h.blackjack ? pos(bold("BLACKJACK")) : h.bust ? neg(`${h.value} · BUST`) : bold(String(h.value));
}
function bjTrailing(v: BjView, p: string, h: BjHand, deltas?: Record<string, number>): string {
  if (v.complete && h.outcome) return outcomeLabel(h.outcome, deltas?.[p] ?? null);
  return !v.complete && p === v.turn ? accent("◀ to act") : "";
}
function bjDealerVal(v: BjView): string {
  return v.dealer.hidden ? dim("?") : v.dealer.bust ? neg(`${v.dealer.value} · BUST`) : dim(String(v.dealer.value));
}

/** The dealer up top, a felt divider, then each seat as a row of full-size cards. Lines only. */
function bjBigLines(v: BjView, nameFor: (id: string) => string, deltas?: Record<string, number>): string[] {
  const sections: string[][] = [
    [bjSeatHeader(accent2(bold("DEALER")), bjDealerVal(v), ""), ...bigHandLines(v.dealer.cards, v.dealer.hidden)],
  ];
  for (const p of v.players) {
    const h = v.hands[p];
    if (!h) continue;
    const who = p === v.you ? accent(bold("YOU")) : accent2(nameFor(p));
    const bet = v.antes?.[p] ?? 0;
    // Each seat shows its OWN bet (per-player stakes) — different seats can bet different amounts.
    const label = bet > 0 ? `${who} ${dim(`· bet ${bet}`)}` : who;
    sections.push([bjSeatHeader(label, bjValue(h), bjTrailing(v, p, h, deltas)), ...bigHandLines(h.cards)]);
  }
  const width = Math.max(24, ...sections.flat().map(visibleLen));
  const felt = dim("·".repeat(width));
  const lines: string[] = [];
  sections.forEach((sec, i) => {
    if (i > 0) lines.push(felt);
    lines.push(...sec);
  });
  return lines;
}

/** One row per seat: label · one-line hand · value · note. Compact — good for many seats. */
function bjCompactLines(v: BjView, nameFor: (id: string) => string, deltas?: Record<string, number>): string[] {
  const labelW = Math.max(6, ...v.players.map((p) => visibleLen(p === v.you ? "YOU" : nameFor(p))));
  const dealer = `${padEndVisible(accent2(bold("DEALER")), labelW)}  ${bracketHand(v.dealer.cards, v.dealer.hidden)}   ${bjDealerVal(v)}`;
  const rows: string[] = [];
  for (const p of v.players) {
    const h = v.hands[p];
    if (!h) continue;
    const label = p === v.you ? accent(bold("YOU")) : accent2(nameFor(p));
    rows.push(`${padEndVisible(label, labelW)}  ${bracketHand(h.cards)}   ${bjValue(h)}   ${bjTrailing(v, p, h, deltas)}`);
  }
  const width = Math.max(24, visibleLen(dealer), ...rows.map(visibleLen));
  return [dealer, dim("·".repeat(width)), ...rows];
}

/** The board content LINES (no box). Dispatch on the layout preference (ui.setLayout), then a
 *  FIT ladder: the canvas silently drops overflow rows, so when the big-cards layout is taller
 *  than the available height (`maxRows`, from GameCtx.boardRows) it would amputate the LAST
 *  seat's cards — never show a partial table; fall back to the compact one-row-per-seat layout
 *  (which fits any seat count). Fit wins over the "big" preference: a cropped board isn't a
 *  layout choice, it's a broken one. */
export function bjBoardLines(
  v: BjView,
  nameFor: (id: string) => string,
  deltas?: Record<string, number>,
  maxRows?: number,
  maxCols?: number,
): string[] {
  if (getLayout() === "compact") return bjCompactLines(v, nameFor, deltas);
  const big = bjBigLines(v, nameFor, deltas);
  // Fall back to compact when big-cards would be cropped either vertically (maxRows, boardRows) OR
  // horizontally (maxCols, boardCols) — a card sheared off the right edge is as broken as a dropped
  // seat. Both bounds are optional, so an un-budgeted caller keeps the full big layout.
  const tooTall = maxRows !== undefined && big.length > maxRows;
  const tooWide = maxCols !== undefined && big.reduce((w, l) => Math.max(w, visibleLen(l)), 0) > maxCols;
  if (tooTall || tooWide) return bjCompactLines(v, nameFor, deltas);
  return big;
}

/** A tiny sample board for the settings preview — a labelled box reflecting the live theme
 *  + layout (rendered as a preview panel inside the settings canvas). `maxRows` is the TOTAL
 *  box budget (borders included); it threads into the same fit ladder that protects the live
 *  board, so the preview degrades big→compact instead of being amputated by the canvas. */
export function bjSampleBoard(maxRows?: number): string {
  const view: BjView = {
    you: "you",
    players: ["you"],
    ante: 50,
    hands: { you: { cards: [{ rank: "A", suit: "S" }, { rank: "K", suit: "D" }], value: 21, bust: false, blackjack: true, outcome: null } },
    dealer: { cards: [{ rank: "J", suit: "D" }], value: 0, hidden: true, bust: false },
    turn: "you",
    yourTurn: true,
    complete: false,
    winner: null,
  };
  // box() spends 2 rows on its own borders — the ladder budget is for the CONTENT lines.
  return box(bjTitle(view, "demo"), bjBoardLines(view, (id) => id, undefined, maxRows === undefined ? undefined : maxRows - 2));
}

/** Local hand value (aces 11→1) for animating partial deals (the authoritative value is server-side). */
function bjHandValue(cards: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += c.rank === "A" ? 11 : "TJQK".includes(c.rank) ? 10 : Number(c.rank);
    if (c.rank === "A") aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function partialBjView(view: BjView, shown: Record<string, number>): BjView {
  const hands: BjView["hands"] = {};
  for (const p of view.players) {
    const cards = (view.hands[p]?.cards ?? []).slice(0, shown[p] ?? 0);
    hands[p] = { cards, value: bjHandValue(cards), bust: false, blackjack: false, outcome: null };
  }
  const dn = shown[DEALER_KEY] ?? 0;
  const dcards = view.dealer.cards.slice(0, Math.min(dn, view.dealer.cards.length));
  return {
    ...view,
    hands,
    dealer: { cards: dcards, value: bjHandValue(dcards), hidden: dn >= 2, bust: false },
    turn: null,
    yourTurn: false,
    complete: false,
  };
}

/**
 * Frames (each a full board string) that deal the opening blackjack hand one card at a time
 * (each player then the dealer, twice — the dealer's second card lands face-down). The final
 * frame is the freshly-dealt board.
 */
export function dealFrames(view: BjView, nameFor: (id: string) => string, maxRows?: number, maxCols?: number): string[] {
  const order: string[] = [];
  for (let r = 0; r < 2; r++) {
    for (const p of view.players) order.push(p);
    order.push(DEALER_KEY);
  }
  const shown: Record<string, number> = { [DEALER_KEY]: 0 };
  for (const p of view.players) shown[p] = 0;
  // Fit is decided ONCE from the FULL dealt board, not per partial frame — a mid-deal layout
  // flip (a half-dealt table fits big, the full one doesn't) would visibly bump the table. Match the
  // render's fit ladder: fall to compact when the full board is too tall OR too wide.
  const full = bjBigLines(view, nameFor);
  const compact =
    getLayout() === "compact" ||
    (maxRows !== undefined && full.length > maxRows) ||
    (maxCols !== undefined && full.reduce((w, l) => Math.max(w, visibleLen(l)), 0) > maxCols);
  return order.map((who) => {
    shown[who] = (shown[who] ?? 0) + 1;
    const partial = partialBjView(view, shown);
    return (compact ? bjCompactLines(partial, nameFor) : bjBigLines(partial, nameFor)).join("\n");
  });
}

/**
 * Rainbow celebrate frames for hitting 21 / a natural — a board-FREE waving rainbow banner that
 * briefly REPLACES the whole canvas (then the shell repaints the board, with the "★ TWENTY-ONE ★"
 * label in the reserved note row). It used to append below the board, which shoved the board
 * upward; standing alone, it never moves the board. A fixed banner width (46) centres cleanly in
 * any canvas (CW ≥ 58). PURE.
 */
export function bjCelebrateFrames(kind: "21" | "blackjack", subtitle = "", maxCols?: number): string[] {
  const head = kind === "blackjack" ? "★  B L A C K J A C K !  ★" : "★  T W E N T Y · O N E !  ★";
  // Clamp the banner to the canvas width so it never overruns / gets sheared on a narrow terminal
  // (it used to assume CW ≥ 58). Floors at the headline width so the text always fits.
  const W = Math.min(46, Math.max(visibleLen(head), maxCols ?? 46));
  const bar = "═".repeat(W);
  const stars = "✦ · ✧ · ✦ · ✧ · ✦ · ✧ · ✦";
  const frames: string[] = [];
  for (let f = 0; f < 14; f++) {
    const ban = [bar, center(stars, W), center(head, W), center(subtitle, W), center(stars, W), bar].map((l) =>
      rainbow(l, f * 26),
    );
    frames.push(ban.join("\n"));
  }
  return frames;
}

/** True when `view` is a just-dealt opening hand (every seat has exactly 2 cards, the dealer
 *  shows one card + a hole, nothing resolved) — the cue to play the deal animation.
 *
 *  The server sends only the dealer's UP-CARD while the hole is hidden (`dealer.cards` has
 *  length 1, `hidden: true` — the renderer appends the face-down hole), so the live opening
 *  hand has ONE shown dealer card, not two. (Checking for two here meant this never matched a
 *  real view and the deal animation silently never fired — only the demo, which mis-shaped the
 *  view with both cards, animated.) */
function isFreshDeal(view: BjView): boolean {
  if (view.complete) return false;
  if (!(view.dealer.cards.length === 1 && view.dealer.hidden)) return false;
  return view.players.every((p) => {
    const h = view.hands[p];
    return !!h && h.cards.length === 2 && h.outcome === null;
  });
}

const MOVES: Record<string, string> = { h: "hit", s: "stand" };

export const blackjackUI: GameUI<BjView> = {
  id: "blackjack",
  title: "Blackjack",
  // A real multiplayer table: matchmake (find) onto a shared table the server fills, rather than
  // allocating a solo-vs-dealer room. The dealer stays — it's the game — but you sit at a table
  // with other players, all playing the house.
  menu: { label: "Blackjack", stake: "wager", defaultStake: 50, find: true, blurb: "Beat the dealer to 21.", players: "2-3P" },
  completion: "continuous",

  // Menu preview: a single seat dealt 12, then hit to 21 (rendered through the real `render`,
  // cycled by the submenu). One seat keeps it narrow enough for the side panel.
  preview() {
    const hand = (cards: BjHand["cards"], value: number, outcome: BjHand["outcome"] = null): BjHand => ({ cards, value, bust: false, blackjack: false, outcome });
    const mk = (cards: BjHand["cards"], value: number, dealer: BjView["dealer"], done = false, outcome: BjHand["outcome"] = null): BjView => ({
      you: "you", players: ["you"], ante: 100, antes: { you: 100 },
      hands: { you: hand(cards, value, outcome) },
      dealer, turn: done ? null : "you", yourTurn: !done, complete: done, winner: done ? "you" : null,
    });
    const hole: BjView["dealer"] = { cards: [{ rank: "K", suit: "S" }], value: 10, hidden: true, bust: false };
    const reveal: BjView["dealer"] = { cards: [{ rank: "K", suit: "S" }, { rank: "8", suit: "D" }], value: 18, hidden: false, bust: false };
    const c1: BjHand["cards"] = [{ rank: "7", suit: "H" }, { rank: "5", suit: "C" }];
    const c2: BjHand["cards"] = [...c1, { rank: "4", suit: "S" }];
    const c3: BjHand["cards"] = [...c2, { rank: "5", suit: "D" }];
    return [mk(c1, 12, hole), mk(c2, 16, hole), mk(c3, 21, hole), mk(c3, 21, reveal, true, "win")];
  },

  boardTitle(view, ctx) {
    return bjTitle(view, ctx.room);
  },

  render(view, ctx) {
    return bjBoardLines(view, ctx.nameFor, ctx.lastDeltas, ctx.boardRows, ctx.boardCols);
  },

  controls() {
    return [accent("▶ [h]it  [s]tand")];
  },

  onKey(key: Key): KeyResult {
    const move = MOVES[key.char];
    return move ? { move } : null;
  },

  isMyTurn(view, playing) {
    return playing && view.yourTurn && !view.complete;
  },

  /** Surface the 21 / blackjack moment as a status line the moment the turn ends. */
  status(view, ctx) {
    const mine = view.hands[ctx.myId];
    if (mine && mine.value === 21 && !mine.bust) {
      return pos(bold(mine.blackjack ? "★ BLACKJACK — pays 3:2 ★" : "★ TWENTY-ONE ★"));
    }
    return null;
  },

  /**
   * The blackjack transition animations:
   *  - a fresh opening hand deals card by card (the exported `dealFrames`), and
   *  - reaching 21 — a hit-to-21 or a natural — fires the rainbow celebrate, once.
   * (Continuous tables reset `prevView` to null at each new round, so the deal cue fires
   * per hand.) Driven through the shared `animateFrames` so the TTY/non-TTY branch lives in
   * one place and the animation can't be silently half-wired again.
   */
  async onView(prev, next, ctx, paint) {
    if (prev === null && isFreshDeal(next)) {
      await animateFrames(dealFrames(next, ctx.nameFor, ctx.boardRows, ctx.boardCols), 180, ctx.tty, paint);
    }
    const mine = next.hands[ctx.myId];
    const before = prev?.hands?.[ctx.myId];
    if (mine && mine.value === 21 && !mine.bust && (!before || before.value !== 21)) {
      const kind = mine.blackjack ? "blackjack" : "21";
      // A board-free flash that takes over the canvas, then the shell repaints the board with the
      // 21/blackjack label in the reserved note row (status) — so the board never jumps.
      const frames = bjCelebrateFrames(kind, mine.blackjack ? "pays 3:2" : "", ctx.boardCols);
      await animateFrames(frames, 60, ctx.tty, paint);
    }
  },
};
