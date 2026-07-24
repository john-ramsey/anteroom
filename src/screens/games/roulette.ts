/**
 * Roulette — a self-contained client `GameUI` module for the MULTIPLAYER table.
 *
 * A shared table vs the house: everyone bets at the SAME TIME (red/black/odd/even/lo/hi, dozen, or a
 * straight pick), locks in with [space], and once every seat is ready ONE shared wheel spin resolves
 * the whole table together. The European-order wheel track, the straight pick selector + working bet
 * amount (kept in `ctx.ui`), the per-seat roster (stack · bets · ready ✓), and the wheel-spin
 * animation all live here. The server owns the wheel + every payout; the client only renders.
 */
import {
  accent,
  animateFrames,
  bold,
  center,
  dim,
  fmtChips,
  neg,
  pos,
  rule,
  warn,
} from "../../ui.ts";
import { seatRosterRow } from "./seatRoster.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, GameUiState, KeyResult } from "./types.ts";

/** The opaque server view, narrowed to Roulette's shape. */
export interface RouletteBet {
  id: string;
  kind: "straight" | "red" | "black" | "odd" | "even" | "low" | "high" | "dozen";
  number: number | null;
  amount: number;
}
export interface RouletteSeat {
  stack: number;
  ready: boolean;
  bets: RouletteBet[];
}
export interface RouletteView {
  you: string;
  players: string[];
  buyIn: number;
  lastNumber: number | null;
  handOver: boolean;
  seats: Record<string, RouletteSeat>;
  net: number;
}

/** Per-game local UI state: the working bet amount ([+]/[-]) and the highlighted straight pick. */
interface RouletteUi extends GameUiState {
  bet: number;
  pick: number;
}

/** The red pockets on a European wheel (display only — the server still decides every payout). */
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const numTint = (n: number): ((s: string) => string) => (n === 0 ? pos : RED.has(n) ? neg : bold);
const colorName = (n: number): string => (n === 0 ? "ZERO" : RED.has(n) ? "RED" : "BLACK");

/** The European single-zero wheel, in physical pocket order. The spin animation slides this
 *  sequence under a fixed pointer, so neighbouring pockets are the real wheel neighbours. */
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const wrap = (i: number): number => ((i % WHEEL.length) + WHEEL.length) % WHEEL.length;
const idxOf = (n: number): number => WHEEL.indexOf(n);

/** The wheel track is `POCKETS` pockets, each `POCKET_W` cols wide, separated and bounded by `│`
 *  rails: `POCKETS×POCKET_W + (POCKETS+1)` = 36 cols. `POCKET_W` is EVEN so a 2-digit number — the
 *  majority of the wheel (10–36) — centres EXACTLY in its pocket. The catch: an even track has no
 *  single centre column (its centre is the seam between the two middle columns), so the pointer and
 *  ball are 2 cols wide and STRADDLE that seam (see `markerLine`). That lands them dead over a
 *  centred 2-digit pocket AND on the wheel's exact centre at once — where a 1-col marker on an even
 *  track (or a centred 2-digit number on an odd track) is always a half-column off. All wheel lines
 *  share WHEEL_W so they centre as ONE aligned block in the canvas. */
const POCKETS = 7;
const POCKET_W = 4; // even ⇒ a 2-digit pocket centres exactly; the 2-wide marker straddles it
const HALF = (POCKETS - 1) >> 1; // 3 — index of the middle (under-marker) pocket
const WHEEL_W = POCKETS * POCKET_W + (POCKETS + 1); // 36
const MARKER_COL = (WHEEL_W - 2) >> 1; // 17 — left col of the 2-wide ▼▼ / ●● marker (cols 17–18 = the centre seam)

/** One pocket cell (`POCKET_W` cols), tinted by colour; the centre pocket is bold, the outer pockets
 *  fade to suggest the wheel curving away. The number is CENTRED in the cell — with an even `POCKET_W`
 *  a 2-digit number sits dead-centre, straddled by the 2-wide marker (a single digit sits under the
 *  marker's left half). */
function pocketCell(n: number, dist: number): string {
  const label = center(String(n), POCKET_W);
  if (dist === 0) return bold(numTint(n)(label));
  if (dist >= 3) return dim(label);
  return numTint(n)(label);
}

/** A WHEEL_W-wide line carrying the 2-wide centre marker (the pointer ▼▼ or the ball ●●) on the two
 *  middle columns. `marker` is exactly 2 visible cols; colour doesn't affect the fixed-width pads. */
function markerLine(marker: string): string {
  return " ".repeat(MARKER_COL) + marker + " ".repeat(WHEEL_W - MARKER_COL - 2);
}

/** The 5-line wheel track centred on `centerIdx` (a WHEEL index): pointer ▼, top rim, the
 *  7-pocket window, bottom rim, and the ball seated under the pointer. PURE. */
function wheelLines(centerIdx: number, ballTint: (s: string) => string): string[] {
  const cells = Array.from({ length: POCKETS }, (_, k) => pocketCell(WHEEL[wrap(centerIdx + k - HALF)]!, Math.abs(k - HALF)));
  const rim = (l: string, mid: string, r: string): string => dim(l + Array(POCKETS).fill("─".repeat(POCKET_W)).join(mid) + r);
  return [
    markerLine(accent("▼▼")),
    rim("╭", "┬", "╮"),
    dim("│") + cells.join(dim("│")) + dim("│"),
    rim("╰", "┴", "╯"),
    markerLine(ballTint("●●")),
  ];
}

/** A single bet, with its stake (the per-game part of the shared roster row). */
function betLabel(b: RouletteBet): string {
  switch (b.kind) {
    case "straight":
      return `Straight→${b.number} ${b.amount}`;
    case "dozen":
      return `Dozen→${b.number} ${b.amount}`;
    case "low":
      return `Lo ${b.amount}`;
    case "high":
      return `Hi ${b.amount}`;
    default:
      return `${b.kind.charAt(0).toUpperCase() + b.kind.slice(1)} ${b.amount}`;
  }
}

/** The caption under the wheel: the settled pocket + colour, the live straight pick, or a
 *  spinning marker. PURE. */
function wheelCaption(ui: RouletteUi, displayIdx: number, spinning: boolean, settled: boolean, won: boolean): string {
  if (spinning) return dim("spinning…");
  if (settled) {
    const n = WHEEL[displayIdx]!;
    return `${(won ? pos : numTint(n))(bold(` ${n} `))}   ${dim(colorName(n))}`;
  }
  return `${dim("straight ▸")} ${numTint(ui.pick)(bold(` ${ui.pick} `))} ${dim("◂   ←/→ aim the wheel")}`;
}

/** The table content LINES (no box — the shell frames it in the canvas). PURE. `displayIdx` is
 *  the WHEEL index the track is centred on (the settled pocket, or your live straight pick). */
function rouletteLines(
  view: RouletteView,
  ui: RouletteUi,
  nameFor: (id: string) => string,
  displayIdx: number,
  spinning: boolean,
  settled: boolean,
  won: boolean,
  maxCols?: number,
): string[] {
  // Default 58 (the canvas floor) so a multi-bet seat roster row (≈57 cols) shows in full. With a
  // width budget (GameCtx.boardCols) it tracks the canvas instead, so on a narrow terminal the wheel
  // stays CENTRED (not left-shifted + ellipsised) and the roster tightens — floored at WHEEL_W so
  // the wheel itself never truncates.
  const inner = maxCols === undefined ? 58 : Math.max(WHEEL_W, Math.min(58, maxCols));
  const head = spinning
    ? dim("● spinning…")
    : view.lastNumber === null
      ? dim("place your bets, then [space] to lock in")
      : dim("last spin");
  const ballTint = settled ? (won ? pos : numTint(WHEEL[displayIdx]!)) : spinning ? accent : dim;

  const lines: string[] = [center(head, inner), ""];
  lines.push(...wheelLines(displayIdx, ballTint).map((l) => center(l, inner)));
  lines.push(center(wheelCaption(ui, displayIdx, spinning, settled, won), inner));
  lines.push(rule(inner));
  for (const p of view.players) lines.push(seatRosterRow(view, p, nameFor, betLabel, inner));
  // Trailing space below the roster: the canvas centres the whole block, so weighting it downward
  // raises the wheel a little (it otherwise sat slightly low with only a few seat rows beneath it).
  lines.push("", "");
  return lines;
}

const myStack = (view: RouletteView): number => view.seats[view.you]?.stack ?? 0;

/** How long each spin frame holds — shared by the in-game reveal AND the menu preview. */
const SPIN_FRAME_MS = 85;
/** The wheel's ease-out travel: several pockets per frame slowing to a drawn-out tail of
 *  one-pocket "ticks" that builds the tension as the ball settles. */
const SPIN_STEPS = [7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1];

/** The WHEEL indices the spin passes through, landing EXACTLY on `endIdx` — the start is
 *  derived from the step sum, so the landing stays true no matter how the curve changes.
 *  Shared by `onView` (the live reveal) and `previewFrames` (the menu spin). PURE. */
function spinIndices(endIdx: number): number[] {
  let cur = wrap(endIdx - SPIN_STEPS.reduce((a, b) => a + b, 0));
  return SPIN_STEPS.map((s) => (cur = wrap(cur + s)));
}

export const rouletteUI: GameUI<RouletteView> = {
  id: "roulette",
  title: "Roulette",
  menu: { label: "Roulette", stake: "buyin", defaultStake: 100, find: true, blurb: "Pick a number, one shared spin.", players: "2-6P" },
  completion: "continuous",

  // Menu preview: the REAL wheel spin — the same ease-out travel the in-game `onView` plays
  // (shared `spinIndices`), ticking at the same cadence, landing on the straight-17 pick and
  // holding the payoff a beat. One coherent bet: buy-in 200, 50 staked (30 red + 20 straight-17)
  // ⇒ 150 chips while the ball rolls, 870 when 17 hits (20×36 back); the visible chip count
  // never drops mid-loop (menuPreview.test.ts pins this — the old snapshots yo-yoed 130↔870).
  previewFrames(ctx) {
    const ui = ctx.ui as RouletteUi;
    const bets: RouletteBet[] = [
      { id: "b1", kind: "red", number: null, amount: 30 },
      { id: "b2", kind: "straight", number: 17, amount: 20 },
    ];
    const spinView: RouletteView = {
      you: "you", players: ["you"], buyIn: 200, lastNumber: null, handOver: false,
      seats: { you: { stack: 150, ready: true, bets } }, net: 0,
    };
    const wonView: RouletteView = {
      ...spinView, lastNumber: 17, handOver: true,
      seats: { you: { stack: 870, ready: false, bets: [] } }, net: 670,
    };
    const endIdx = idxOf(17);
    const frames = spinIndices(endIdx).map((idx) =>
      rouletteLines(spinView, ui, ctx.nameFor, idx, true, false, false, ctx.boardCols),
    );
    const settled = rouletteLines(wonView, ui, ctx.nameFor, endIdx, false, true, true, ctx.boardCols);
    for (let i = 0; i < 8; i++) frames.push(settled); // hold the landing before the loop restarts
    return { frames, ms: SPIN_FRAME_MS };
  },

  initUi(): RouletteUi {
    return { bet: 50, pick: 17 };
  },

  boardTitle(view, ctx) {
    return `Roulette  ·  room ${ctx.room}  ·  buy-in ${fmtChips(view.buyIn)}`;
  },

  render(view, ctx) {
    const ui = ctx.ui as RouletteUi;
    const settled = view.lastNumber !== null;
    // Settled → the wheel rests on the landed pocket; betting → it sits on your straight pick,
    // so ←/→ visibly rotates the wheel to the number you're aiming at.
    const displayIdx = settled && view.lastNumber !== null ? idxOf(view.lastNumber) : idxOf(ui.pick);
    return rouletteLines(view, ui, ctx.nameFor, displayIdx, false, settled, false, ctx.boardCols);
  },

  controls(view, ctx) {
    const ui = ctx.ui as RouletteUi;
    // Broken into clear chunks, each kept within the canvas floor (≤58) so the footer
    // never overruns the box: OUTSIDE/even-money bets, then INSIDE bets, then the amount + action.
    return [
      accent("▶ [r]ed [b]lack  ·  [o]dd [e]ven  ·  [l]o [h]i"),
      accent("  [1/2/3] dozen  ·  [←/→] aim  [enter] straight-up"),
      `${dim("bet")} ${bold(String(ui.bet))} ${dim("[+/-]")}    ${accent(bold("[space] lock in & spin"))}`,
    ];
  },

  isMyTurn(view, playing) {
    const seat = view.seats[view.you];
    return playing && !view.handOver && !!seat && !seat.ready;
  },

  status(view) {
    if (view.handOver) return null; // the settlement tally + next-deal banner take over
    if (view.lastNumber !== null) return dim(`landed on ${view.lastNumber} · ${colorName(view.lastNumber)}`);
    return null;
  },

  onKey(k: Key, view, ctx): KeyResult {
    const ui = ctx.ui as RouletteUi;
    // Local pick selector + bet stepper (no server round-trip).
    if (k.name === "left") {
      ui.pick = (ui.pick - 1 + 37) % 37;
      return { handled: true };
    }
    if (k.name === "right") {
      ui.pick = (ui.pick + 1) % 37;
      return { handled: true };
    }
    if (k.char === "+" || k.char === "=") {
      ui.bet = Math.min(myStack(view) || ui.bet, ui.bet + 25);
      return { handled: true };
    }
    if (k.char === "-" || k.char === "_") {
      ui.bet = Math.max(5, ui.bet - 25);
      return { handled: true };
    }

    if (k.name === "space" || k.char === " ") {
      return { move: { kind: "ready" }, keepTurn: false, status: dim("locked in — waiting for the table…") };
    }

    const amount = Math.min(ui.bet, myStack(view));
    if (amount <= 0) return { handled: true, status: warn("no chips left this hand") };

    const place = (bet: RouletteBet["kind"], number?: number): KeyResult => ({
      move: { kind: "place", bet, amount, ...(number !== undefined ? { number } : {}) },
      keepTurn: true,
      status: dim(`bet ${amount} on ${bet}${number !== undefined ? ` ${number}` : ""}`),
    });

    if (k.name === "return") return place("straight", ui.pick);
    switch (k.char) {
      case "r":
        return place("red");
      case "b":
        return place("black");
      case "o":
        return place("odd");
      case "e":
        return place("even");
      case "l":
        return place("low");
      case "h":
        return place("high");
      case "1":
        return place("dozen", 1);
      case "2":
        return place("dozen", 2);
      case "3":
        return place("dozen", 3);
      default:
        return null;
    }
  },

  async onView(prev, next, ctx, paint) {
    const landed = next.lastNumber;
    if (landed === null) return;
    const isNewSpin = !prev || prev.lastNumber !== landed; // a fresh pocket resolved
    if (!isNewSpin) return;
    const ui = ctx.ui as RouletteUi;
    const youStack = (v: RouletteView | null): number => (v ? (v.seats[v.you]?.stack ?? 0) : 0);
    const won = !!prev && youStack(prev) < youStack(next);

    // Slide the wheel under the pointer with the shared ease-out travel (`spinIndices`), landing
    // EXACTLY on the real pocket — a genuine wheel spin.
    const endIdx = idxOf(landed);
    const frames = spinIndices(endIdx).map((idx) =>
      rouletteLines(next, ui, ctx.nameFor, idx, true, false, false, ctx.boardCols).join("\n"),
    );
    frames.push(rouletteLines(next, ui, ctx.nameFor, endIdx, false, true, won, ctx.boardCols).join("\n")); // settle (+ flash on a win)
    await animateFrames(frames, SPIN_FRAME_MS, ctx.tty, paint);
  },
};
