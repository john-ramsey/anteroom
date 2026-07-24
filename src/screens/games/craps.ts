/**
 * Craps — a self-contained client `GameUI` module for the MULTIPLAYER table.
 *
 * A shared table vs the house: everyone bets at the SAME TIME (place Pass/Don't Pass at the
 * come-out, Field any roll), locks in with [space], and once every seat is ready the table rolls
 * together. The point puck, the pip dice, the per-seat roster (stack · bets · ready ✓), the working
 * bet amount (kept in `ctx.ui`), the dice-tumble animation, and the keypad all live here. The
 * server owns the dice + every payout; the client only renders.
 */
import { accent, animateFrames, bold, center, diceLines, dim, fmtChips, pos, rule, warn } from "../../ui.ts";
import { seatRosterRow } from "./seatRoster.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, GameUiState, KeyResult } from "./types.ts";

/** The opaque server view, narrowed to Craps's shape. */
export interface CrapsBet {
  kind: "pass" | "dontpass" | "field";
  number: number | null;
  amount: number;
}
export interface CrapsSeat {
  stack: number;
  ready: boolean;
  bets: CrapsBet[];
}
export interface CrapsView {
  you: string;
  players: string[];
  buyIn: number;
  phase: "comeout" | "point";
  point: number | null;
  lastRoll: [number, number] | null;
  handOver: boolean;
  seats: Record<string, CrapsSeat>;
  net: number;
}

/** Per-game local UI state: the working bet amount cycled with [+]/[-]. */
interface CrapsUi extends GameUiState {
  bet: number;
}

/** The dice block: the shared pip dice (ui.diceLines) for a real roll, or a 5-line placeholder
 *  before the first roll of a hand (the placeholder is craps' own UX). */
function diceBlock(roll: [number, number] | null, hot: boolean): string[] {
  return roll ? diceLines(roll, hot) : ["", "", dim("— place your bets, then roll —"), "", ""];
}

/** A single bet, with its stake (the per-game part of the shared roster row). */
function betLabel(b: CrapsBet): string {
  if (b.kind === "pass") return `Pass${b.number ? `→${b.number}` : ""} ${b.amount}`;
  if (b.kind === "dontpass") return `Don't${b.number ? `→${b.number}` : ""} ${b.amount}`;
  return `Field ${b.amount}`;
}

function outcomeLine(view: CrapsView): string {
  if (!view.lastRoll) return dim("press [space] to roll once everyone's in");
  const [a, b] = view.lastRoll;
  return `${bold(`${a} + ${b} = ${a + b}`)}${a === b ? dim(" · hard") : ""}`;
}

/** A one-line dice readout for a tight terminal — the two faces + the total — in place of the
 *  5-line pip block, so every seat still fits. ASCII digits (no wide dice glyphs) keep the box
 *  edges aligned. */
function inlineDice(roll: [number, number] | null, hot: boolean): string {
  if (!roll) return dim("— place your bets, then roll —");
  const [a, b] = roll;
  const s = `${bold(String(a))} ${dim("+")} ${bold(String(b))}   ${bold(`= ${a + b}`)}`;
  return hot ? pos(bold(s)) : s;
}

/** The table content LINES (no box). `dice`/`hot` let the spin animation override the readout.
 *  With `maxCols`/`maxRows` (from GameCtx) the table adapts: it narrows to the width, collapses the
 *  5-line pip block to a one-line readout when the seats wouldn't otherwise fit the height, and
 *  summarises overflow seats as "+N more" instead of letting the canvas silently drop them. Both
 *  bounds are optional — an un-budgeted caller keeps the full fixed-46 table. PURE. */
function crapsLines(
  view: CrapsView,
  nameFor: (id: string) => string,
  dice: [number, number] | null,
  hot: boolean,
  maxCols?: number,
  maxRows?: number,
): string[] {
  const inner = maxCols === undefined ? 46 : Math.max(28, Math.min(46, maxCols));
  const puck = view.point ? warn(bold(`● POINT ${view.point}`)) : dim("○ COME OUT");
  // Full board = 5-line dice + 5 chrome rows (puck, blank, blank, outcome, rule) + one row/seat.
  const compactDice = maxRows !== undefined && 10 + view.players.length > maxRows;
  const lines: string[] = [center(puck, inner), ""];
  if (compactDice) lines.push(center(inlineDice(dice, hot), inner));
  else lines.push(...diceBlock(dice, hot).map((l) => center(l, inner)));
  lines.push("", center(outcomeLine(view), inner), rule(inner));
  // Seat overflow: cap the roster to the row budget and summarise the rest, so the last seats are
  // never silently cropped by the canvas.
  const headRows = (compactDice ? 1 : 5) + 5;
  let shown = view.players;
  let more = 0;
  if (maxRows !== undefined && view.players.length > maxRows - headRows) {
    shown = view.players.slice(0, Math.max(1, maxRows - headRows - 1));
    more = view.players.length - shown.length;
  }
  for (const p of shown) lines.push(seatRosterRow(view, p, nameFor, betLabel, inner));
  if (more > 0) lines.push(center(dim(`+${more} more`), inner));
  return lines;
}

const myStack = (view: CrapsView): number => view.seats[view.you]?.stack ?? 0;

export const crapsUI: GameUI<CrapsView> = {
  id: "craps",
  title: "Craps",
  menu: { label: "Craps", stake: "buyin", defaultStake: 100, find: true, blurb: "Bet the line, roll together.", players: "2-6P" },
  completion: "continuous",

  // Menu preview: a pass-line bet, then a natural 7 on the come-out (rendered through the real
  // `render`, cycled by the submenu). One seat keeps it narrow.
  preview() {
    const seat = (stack: number, bets: CrapsBet[]): CrapsSeat => ({ stack, ready: false, bets });
    const pass: CrapsBet[] = [{ kind: "pass", number: null, amount: 30 }];
    const mk = (roll: [number, number] | null, stack: number, net: number): CrapsView => ({
      you: "you", players: ["you"], buyIn: 200, phase: "comeout", point: null, lastRoll: roll, handOver: false,
      seats: { you: seat(stack, roll ? [] : pass) }, net,
    });
    return [mk(null, 170, -30), mk([2, 3], 170, -30), mk([5, 4], 170, -30), mk([3, 4], 230, 30), mk([6, 5], 230, 30)];
  },

  initUi(): CrapsUi {
    return { bet: 25 };
  },

  boardTitle(view, ctx) {
    return `Craps  ·  room ${ctx.room}  ·  buy-in ${fmtChips(view.buyIn)}`;
  },

  render(view, ctx) {
    return crapsLines(view, ctx.nameFor, view.lastRoll, false, ctx.boardCols, ctx.boardRows);
  },

  controls(view, ctx) {
    const ui = ctx.ui as CrapsUi;
    const betStr = `${dim("bet")} ${bold(String(ui.bet))} ${dim("[+/-]")}`;
    // Chunked: the line/field bets on one row, the amount + action on the next.
    const place =
      view.phase === "comeout" ? accent("▶ line:  [p]ass  [d]on't pass  ·  [f]ield") : accent("▶ [f]ield");
    return [place, `${betStr}    ${accent(bold("[space] lock in & roll"))}`];
  },

  isMyTurn(view, playing) {
    const seat = view.seats[view.you];
    return playing && !view.handOver && !!seat && !seat.ready;
  },

  status(view) {
    if (view.handOver) return null; // the settlement tally + next-deal banner take over
    if (view.lastRoll) {
      const [a, b] = view.lastRoll;
      return dim(`rolled ${a} + ${b} = ${a + b}${view.point ? ` · point ${view.point}` : ""}`);
    }
    return view.point ? dim(`point is ${view.point}`) : dim("come-out roll");
  },

  onKey(k: Key, view, ctx): KeyResult {
    const ui = ctx.ui as CrapsUi;
    if (k.char === "+" || k.char === "=") {
      ui.bet = Math.min(myStack(view) || ui.bet, ui.bet + 25);
      return { handled: true };
    }
    if (k.char === "-" || k.char === "_") {
      ui.bet = Math.max(5, ui.bet - 25);
      return { handled: true };
    }
    if (k.name === "space" || k.char === " " || k.name === "return") {
      return { move: { kind: "ready" }, keepTurn: false, status: dim("locked in — waiting for the table…") };
    }

    const amount = Math.min(ui.bet, myStack(view));
    if (amount <= 0) return { handled: true, status: warn("no chips left this hand") };
    const place = (bet: CrapsBet["kind"]): KeyResult => ({
      move: { kind: "place", bet, amount },
      keepTurn: true,
      status: dim(`bet ${amount} on ${bet}`),
    });
    switch (k.char) {
      case "p":
        return view.phase === "comeout" ? place("pass") : { handled: true, status: warn("Pass is come-out only") };
      case "d":
        return view.phase === "comeout" ? place("dontpass") : { handled: true, status: warn("Don't Pass is come-out only") };
      case "f":
        return place("field");
      default:
        return null;
    }
  },

  async onView(prev, next, ctx, paint) {
    const landed = next.lastRoll;
    if (!landed) return;
    const p = prev?.lastRoll;
    const isNewRoll = !p || p[0] !== landed[0] || p[1] !== landed[1];
    if (!isNewRoll) return;
    const youStack = (v: CrapsView | null): number => (v ? (v.seats[v.you]?.stack ?? 0) : 0);
    const won = !!prev && youStack(prev) < youStack(next);
    const [fa, fb] = landed;
    const frames: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = ((i + fa) % 6) + 1;
      const b = ((i * 2 + fb) % 6) + 1;
      frames.push(crapsLines(next, ctx.nameFor, [a, b], false, ctx.boardCols, ctx.boardRows).join("\n"));
    }
    frames.push(crapsLines(next, ctx.nameFor, landed, won, ctx.boardCols, ctx.boardRows).join("\n")); // settle (+ flash on a win)
    await animateFrames(frames, 65, ctx.tty, paint);
  },
};
