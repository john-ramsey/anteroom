/**
 * Reversi (Othello) — a self-contained client `GameUI` module.
 *
 * One-shot, two-player, CASUAL (no stakes). The board renderer, the legal-cell cursor (kept in
 * `ctx.ui`), the flip-cascade animation, the ←/→/enter input, and the end-of-match summary all
 * live here; the session shell never branches on the game id (it resolves via the registry).
 *
 * Seat 0 = your discs in `accent`, seat 1 = the opponent's in `accent2`, empty cells dim. On your
 * turn the server-supplied legal cells are marked (◌) and the cursor (◉) hops only between them,
 * so you can never aim an illegal placement. The server owns all the rules; the client just paints
 * `view.legal`.
 */
import { accent, accent2, animateFrames, bold, dim, neg, pos, sparkle, warn } from "../../ui.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, GameUiState, KeyResult } from "./types.ts";

/** The opaque server view, narrowed to Reversi's shape. */
export interface RevView {
  you: string;
  youSeat: number;
  opponent: string | null;
  /** Seat-ordered roster (a spectator holds no seat, so `you`/`opponent` can't name the table).
   *  Optional only for older fabricated views — the wire always carries it. */
  players?: string[];
  size: number;
  /** board[row][col]: -1 empty, 0 | 1 seat. */
  board: number[][];
  turn: 0 | 1;
  yourTurn: boolean;
  winner: string | null;
  complete: boolean;
  scores: Record<string, number>;
  legal: Array<[number, number]>;
  lastMove: { row: number; col: number } | null;
}

/** Per-game local UI state: which legal cell the cursor is on (an index into `view.legal`). */
interface RevUi extends GameUiState {
  cursor: number;
}

const key = (r: number, c: number): string => `${r},${c}`;

/** Column file letters (a, b, c, …) — classic Othello/chess notation, so the board reads
 *  unmistakably as a square game grid (and never as Four-in-a-Row's vertical drop board). */
const FILE = (c: number): string => String.fromCharCode(97 + c);

/** A single cell glyph: your disc, the opponent's, the cursor, a legal hint, or an empty cell.
 *  Returns exactly ONE visible column so it centres cleanly inside the 3-wide lattice cell. */
function cellGlyph(
  view: RevView,
  board: number[][],
  r: number,
  c: number,
  cursor: [number, number] | null,
  legal: Set<string>,
  showHints: boolean,
): string {
  const v = board[r]?.[c] ?? -1;
  // A spectator holds no seat (youSeat −1): without a POV fallback BOTH players' discs took the
  // opponent tint and the sides were indistinguishable. Seat 0 = accent, matching the header.
  const pov = view.youSeat >= 0 ? view.youSeat : 0;
  if (v === pov) return accent(bold("●"));
  if (v >= 0) return accent2(bold("●"));
  if (showHints && cursor && cursor[0] === r && cursor[1] === c) return accent(bold("◉"));
  if (showHints && legal.has(key(r, c))) return accent("◌");
  return " "; // an empty cell — the ruled lattice carries the structure
}

/**
 * The board content LINES (no box — the shell frames it in the canvas). PURE.
 *
 * A FULLY-RULED lattice (┌┬┐ / ├┼┤ / └┴┘) with file letters (a–h) across the top and rank
 * numbers down the left — a square board-game grid, deliberately distinct from Four-in-a-Row's
 * open `●`-in-a-thin-box drop grid. Each cell is 3 columns (` X `) so discs sit centred.
 * Kept to one header row + the grid (no blank spacer). When the row budget (`maxRows`, from
 * GameCtx.boardRows) is tight, progressively compact — keeping the horizontal rules for as long as
 * possible: full board → drop the a–h label row (rules intact) → drop the interstitial rules — so
 * the board + footer still fit instead of being cropped by the canvas.
 */
function reversiLines(
  view: RevView,
  nameFor: (id: string) => string,
  board: number[][],
  showHints: boolean,
  cursor: [number, number] | null,
  legal: Set<string>,
  maxRows?: number,
): string[] {
  const n = view.size;
  // A seated player reads the header first-person; a spectator (no seat) reads it seat-vs-seat
  // — the real players by name, never a phantom "@spectator" seat or "waiting…".
  const seated = view.youSeat >= 0;
  const leftId = seated ? view.you : (view.players?.[0] ?? view.you);
  const rightId = seated ? view.opponent : (view.players?.[1] ?? view.opponent);
  const meName = accent(bold(nameFor(leftId)));
  const oppName = rightId ? accent2(nameFor(rightId)) : accent2("waiting…");
  const me = view.scores[leftId] ?? 0;
  const opp = rightId ? (view.scores[rightId] ?? 0) : 0;

  const mover = view.players?.[view.turn];
  const turnNote = view.complete
    ? seated
      ? me > opp
        ? pos("you win")
        : me < opp
          ? neg("you lose")
          : warn("draw")
      : view.winner
        ? pos(`${nameFor(view.winner)} wins`)
        : warn("draw")
    : seated
      ? view.yourTurn
        ? accent("your move")
        : dim("their move")
      : dim(`${mover ? nameFor(mover) : "…"} to move`);

  const header = `${meName}  ${accent("●")} ${bold(String(me))}   ${dim("vs")}   ${bold(String(opp))} ${accent2("●")}  ${oppName}   ${dim("·")}   ${turnNote}`;

  // File coordinates, one per 4-wide cell column (3-char cell + the `│`): "    a   b   c …".
  const fileRow = dim("    " + Array.from({ length: n }, (_, c) => FILE(c)).join("   "));
  const seg = (l: string, mid: string, r: string): string =>
    dim("  " + l + Array.from({ length: n }, () => "───").join(mid) + r);
  const top = seg("┌", "┬", "┐");
  const bottom = seg("└", "┴", "┘");
  const sep = seg("├", "┼", "┤");
  const cellRows = Array.from({ length: n }, (_, r) => {
    const rank = dim(String(n - r)); // 8 at the top down to 1, like a chess board
    const cells = Array.from({ length: n }, (_, c) => ` ${cellGlyph(view, board, r, c, cursor, legal, showHints)} `).join(dim("│"));
    return `${rank} ${dim("│")}${cells}${dim("│")}`;
  });
  const ruled: string[] = [];
  cellRows.forEach((row, r) => {
    ruled.push(row);
    if (r < n - 1) ruled.push(sep);
  });

  // Fit ladder (see the docstring): full → drop the a–h label row (rules kept) → drop the rules.
  const full = [header, fileRow, top, ...ruled, bottom];
  if (maxRows === undefined || full.length <= maxRows) return full;
  const noFile = [header, top, ...ruled, bottom];
  if (noFile.length <= maxRows) return noFile;
  return [header, top, ...cellRows, bottom];
}

/** The cursor cell (an entry of `view.legal`) when hints are showing, else null. */
function cursorCell(view: RevView, ui: RevUi, showHints: boolean): [number, number] | null {
  if (!showHints || view.legal.length === 0) return null;
  return view.legal[Math.min(ui.cursor, view.legal.length - 1)] ?? null;
}

/** Chebyshev distance — the flip cascade radiates outward from the placed disc. */
const ringDist = (r: number, c: number, from: { row: number; col: number }): number =>
  Math.max(Math.abs(r - from.row), Math.abs(c - from.col));

export const reversiUI: GameUI<RevView> = {
  id: "reversi",
  title: "Reversi",
  menu: { label: "Reversi", stake: "none", find: true, blurb: "Outflank and flip the board.", players: "2P" },
  completion: "summary",

  // Menu preview: a REAL alternating opening from the standard four-disc start — you and Rival take
  // turns placing legal outflanking moves, discs flipping BOTH ways, until you finish ahead 7–2.
  // Rendered through the real `render` and cycled by the submenu, so the turn note flips each frame.
  preview() {
    const blank = (): number[][] => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => -1));
    const base = { you: "you", youSeat: 0, opponent: "Rival", size: 8 };
    const mk = (board: number[][], you: number, opp: number, yourTurn: boolean, last: { row: number; col: number } | null, over = false): RevView => ({
      ...base, board, turn: yourTurn ? 0 : 1, yourTurn, winner: over ? "you" : null, complete: over, scores: { you, Rival: opp }, legal: [], lastMove: last,
    });
    // Standard start: your discs at (3,4)+(4,3), Rival's at (3,3)+(4,4).
    const b0 = blank();
    b0[3]![3] = 1; b0[4]![4] = 1; b0[3]![4] = 0; b0[4]![3] = 0;
    const b1 = b0.map((r) => r.slice()); b1[2]![3] = 0; b1[3]![3] = 0; // you (2,3), flip (3,3)
    const b2 = b1.map((r) => r.slice()); b2[2]![4] = 1; b2[3]![4] = 1; // Rival (2,4), flip (3,4)
    const b3 = b2.map((r) => r.slice()); b3[2]![5] = 0; b3[2]![4] = 0; // you (2,5), flip (2,4)
    const b4 = b3.map((r) => r.slice()); b4[4]![2] = 1; b4[4]![3] = 1; // Rival (4,2), flip (4,3)
    const b5 = b4.map((r) => r.slice()); b5[5]![4] = 0; b5[3]![4] = 0; b5[4]![4] = 0; // you (5,4), flip (3,4)+(4,4)
    return [
      mk(b0, 2, 2, true, null),                       // your move to open
      mk(b1, 4, 1, false, { row: 2, col: 3 }),        // you placed → Rival to move
      mk(b2, 3, 3, true, { row: 2, col: 4 }),         // Rival placed → your move
      mk(b3, 5, 2, false, { row: 2, col: 5 }),        // you placed → Rival to move
      mk(b4, 4, 4, true, { row: 4, col: 2 }),         // Rival placed → your move
      mk(b5, 7, 2, false, { row: 5, col: 4 }, true),  // you placed → you win 7–2
    ];
  },

  initUi(): RevUi {
    return { cursor: 0 };
  },

  boardTitle(_view, ctx) {
    return `Reversi  ·  room ${ctx.room}`;
  },

  render(view, ctx) {
    const ui = ctx.ui as RevUi;
    const showHints = ctx.myTurn && !view.complete;
    const legal = new Set(view.legal.map(([r, c]) => key(r, c)));
    return reversiLines(view, ctx.nameFor, view.board, showHints, cursorCell(view, ui, showHints), legal, ctx.boardRows);
  },

  controls() {
    return [accent("▶ ←/→ choose cell  ·  [enter] place")];
  },

  onKey(k: Key, view, ctx): KeyResult {
    const ui = ctx.ui as RevUi;
    const legal = view.legal;
    if (legal.length === 0) return null;
    if (k.name === "left" || k.name === "up") {
      ui.cursor = (ui.cursor - 1 + legal.length) % legal.length;
      return { handled: true };
    }
    if (k.name === "right" || k.name === "down") {
      ui.cursor = (ui.cursor + 1) % legal.length;
      return { handled: true };
    }
    if (k.name === "return" || k.name === "space") {
      const cell = legal[Math.min(ui.cursor, legal.length - 1)];
      if (!cell) return null;
      return { move: { row: cell[0], col: cell[1] }, status: dim(`placing at ${FILE(cell[1])}${view.size - cell[0]} — waiting…`) };
    }
    return null;
  },

  isMyTurn(view, playing) {
    return playing && view.yourTurn && !view.complete;
  },

  async onView(prev, next, ctx, paint) {
    const ui = ctx.ui as RevUi;
    const placed = next.lastMove;
    if (prev && placed) {
      const moverSeat = next.board[placed.row]?.[placed.col] ?? 0;
      const flipped: Array<[number, number]> = [];
      for (let r = 0; r < next.size; r++) {
        for (let c = 0; c < next.size; c++) {
          if ((prev.board[r]?.[c] ?? -1) !== (next.board[r]?.[c] ?? -1) && !(r === placed.row && c === placed.col)) {
            flipped.push([r, c]);
          }
        }
      }
      flipped.sort((a, b) => ringDist(a[0], a[1], placed) - ringDist(b[0], b[1], placed));

      const work = prev.board.map((row) => row.slice());
      const legal = new Set<string>(); // no hints during the animation
      const frame = (): string => reversiLines(next, ctx.nameFor, work, false, null, legal, ctx.boardRows).join("\n");
      const frames: string[] = [];
      work[placed.row]![placed.col] = moverSeat; // the disc lands
      frames.push(frame());
      const chunk = Math.max(1, Math.ceil(flipped.length / 5));
      for (let i = 0; i < flipped.length; i += chunk) {
        for (let j = i; j < Math.min(i + chunk, flipped.length); j++) {
          const [r, c] = flipped[j]!;
          work[r]![c] = moverSeat;
        }
        frames.push(frame());
      }
      if (frames.length > 1) await animateFrames(frames, 70, ctx.tty, paint);
    }
    // Keep the cursor within the next turn's legal cells.
    ui.cursor = next.legal.length ? Math.min(ui.cursor, next.legal.length - 1) : 0;
  },

  summary(view, ctx) {
    const me = view.scores[view.you] ?? 0;
    const opp = view.opponent ? (view.scores[view.opponent] ?? 0) : 0;
    const headline = me > opp ? sparkle("YOU WIN") : me < opp ? neg(bold("YOU LOSE")) : warn(bold("TIE"));
    return [
      dim("final board"),
      "",
      headline,
      "",
      // Both sides are NAMED here. The count pair alone ("8 – 56") is only legible if you can see
      // the two colours, and it used to be followed by a single bare name, which read as a caption
      // for the whole line rather than for one of the numbers.
      `${dim("discs")}   ${accent(ctx.nameFor(view.you))} ${accent(bold(String(me)))}   ${dim("–")}   ${accent2(bold(String(opp)))} ${accent2(view.opponent ? ctx.nameFor(view.opponent) : "—")}`,
      "",
      dim("[space] play again · [m] menu"),
    ];
  },
};
