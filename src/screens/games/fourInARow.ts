/**
 * Four in a Row — a self-contained client `GameUI` module.
 *
 * One-shot, two-player, winner-take-all wager. Moved here from ui.ts / session.ts: the
 * themed grid renderer, the gravity drop animation, the win-line pulse, the column
 * cursor (kept in `ctx.ui`), and the ←/→/enter input mapping. The session shell never
 * branches on the game id.
 */
import { accent, accent2, bold, dim, neg, playInPlace, pos, sparkle, warn } from "../../ui.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, GameUiState, KeyResult } from "./types.ts";

export interface FourView {
  /** `board[col]` is a bottom-up column stack; cell is -1 (empty) or a seat (0|1). */
  board: number[][];
  cols: number;
  rows: number;
  connect: number;
  you: string;
  opponent: string | null;
  /** Seat-ordered roster (a spectator holds no seat, so `you`/`opponent` can't name the table).
   *  Optional only for older fabricated views — the wire always carries it. */
  players?: string[];
  /** The viewer's seat index (which disc value is theirs); -1 for a spectator. */
  youSeat: number;
  yourTurn: boolean;
  turn: number;
  winner: string | null;
  winningLine: Array<[number, number]> | null;
  complete: boolean;
}

/** Empty-cell sentinel — must match the server's empty-cell encoding. */
const FOUR_EMPTY = -1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Per-game local UI state: the currently-aimed column. */
interface FourUi extends GameUiState {
  cursor: number;
}

/** A single board cell: your disc in accent, the opponent's in accent2, empty dim. A
 *  cell on the winning line is brightened (and "pulses" via `hot` during the win flash). */
function fourCell(view: FourView, col: number, row: number, win: Set<string>, hot: boolean): string {
  const v = view.board[col]?.[row] ?? FOUR_EMPTY;
  // A spectator holds no seat (youSeat −1): without a POV fallback BOTH players' discs took the
  // opponent tint and the sides were indistinguishable. Seat 0 = accent, matching the header.
  const mine = v === (view.youSeat >= 0 ? view.youSeat : 0);
  if (win.has(`${col},${row}`)) {
    const tint = hot ? pos : mine ? accent : accent2;
    return tint(bold(hot ? "◉" : "●"));
  }
  if (v === FOUR_EMPTY) return dim("·");
  return mine ? accent(bold("●")) : accent2(bold("●"));
}

/** The canvas frame title for the live board. */
function fourTitle(room: string): string {
  return `Four in a Row  ·  room ${room}`;
}

/**
 * The themed grid as content LINES (no box — the shell frames it in the canvas): a column
 * cursor (▼ + highlighted number) above the board, your discs in accent, the opponent's in
 * accent2, empties dim, the winning line highlighted. PURE. `cursor` is the aimed column
 * (-1 hides it); `winFlash` toggles the brighter "◉" pulse.
 */
export function fourBoardLines(
  view: FourView,
  nameFor: (id: string) => string,
  cursor = -1,
  winFlash = false,
): string[] {
  const win = new Set<string>((view.winningLine ?? []).map(([c, r]) => `${c},${r}`));
  // A seated player reads the header first-person; a spectator (no seat) reads it seat-vs-seat
  // — the real players by name, never a phantom "@spectator" seat or "waiting…".
  const seated = view.youSeat >= 0;
  const leftId = seated ? view.you : (view.players?.[0] ?? view.you);
  const rightId = seated ? view.opponent : (view.players?.[1] ?? view.opponent);
  const meName = accent(bold(nameFor(leftId)));
  const oppName = rightId ? accent2(nameFor(rightId)) : accent2("waiting…");

  const mover = view.players?.[view.turn];
  const turnNote = view.complete
    ? seated
      ? view.winner === view.you
        ? pos("you win")
        : view.winner === null
          ? warn("draw")
          : neg("you lose")
      : view.winner
        ? pos(`${nameFor(view.winner)} wins`)
        : warn("draw")
    : seated
      ? view.yourTurn
        ? accent("your move")
        : dim("their move")
      : dim(`${mover ? nameFor(mover) : "…"} to move`);

  const lines: string[] = [
    `${meName}  ${accent("●")}   ${dim("vs")}   ${rightId ? `${oppName}  ${accent2("●")}` : oppName}   ${dim("·")}   ${turnNote}`,
    "",
  ];

  const arrow = Array.from({ length: view.cols }, (_, c) => (c === cursor ? accent("▼") : " ")).join("  ");
  const nums = Array.from({ length: view.cols }, (_, c) =>
    c === cursor ? accent(bold(String(c + 1))) : dim(String(c + 1)),
  ).join("  ");
  // Frame the label rows EXACTLY like a board cell row (`│ …row… │` → 2 cols of border each side)
  // so the canvas, which centres every line by its own width, gives them the same offset as the
  // board — otherwise the narrower label rows centre 1 column off and the numbers miss the columns.
  lines.push("  " + arrow + "  ", "  " + nums + "  ");

  const span = view.cols * 3;
  lines.push(dim("┌" + "─".repeat(span) + "┐"));
  for (let r = view.rows - 1; r >= 0; r--) {
    const row = Array.from({ length: view.cols }, (_, c) => fourCell(view, c, r, win, winFlash)).join("  ");
    lines.push(dim("│") + " " + row + " " + dim("│"));
  }
  lines.push(dim("└" + "─".repeat(span) + "┘"));

  return lines;
}

/** Frames (each a full board string) that drop a disc down `column` to its landing row (the
 *  gravity animation). The final frame is the disc at rest. `seat` is the dropping player's
 *  disc value. Pure. */
function fourDropFrames(view: FourView, column: number, seat: number, nameFor: (id: string) => string): string[] {
  let landing = -1;
  for (let r = 0; r < view.rows; r++) {
    if ((view.board[column]?.[r] ?? FOUR_EMPTY) === FOUR_EMPTY) {
      landing = r;
      break;
    }
  }
  if (landing < 0) return [fourBoardLines(view, nameFor, column).join("\n")];
  const frames: string[] = [];
  for (let r = view.rows - 1; r >= landing; r--) {
    const board = view.board.map((stack) => stack.slice());
    board[column]![r] = seat;
    frames.push(fourBoardLines({ ...view, board }, nameFor, column).join("\n"));
  }
  return frames;
}

/** The column + seat of the disc that appeared between `prev` and `next` (or null). */
function findDrop(prev: FourView, next: FourView): { col: number; seat: number } | null {
  for (let c = 0; c < next.cols; c++) {
    for (let r = 0; r < next.rows; r++) {
      const before = prev.board[c]?.[r] ?? FOUR_EMPTY;
      const after = next.board[c]?.[r] ?? FOUR_EMPTY;
      if (before === FOUR_EMPTY && after !== FOUR_EMPTY) return { col: c, seat: after };
    }
  }
  return null;
}

/** The first playable column from `from`, or the existing cursor if it's still open. */
function playableColumn(v: FourView, from: number): number {
  if ((v.board[from]?.[v.rows - 1] ?? FOUR_EMPTY) === FOUR_EMPTY) return from;
  for (let c = 0; c < v.cols; c++) {
    if ((v.board[c]?.[v.rows - 1] ?? FOUR_EMPTY) === FOUR_EMPTY) return c;
  }
  return from;
}

async function play(frames: string[], delayMs: number, tty: boolean, paint: (body: string) => void): Promise<void> {
  if (frames.length === 0) return;
  if (tty) {
    for (let i = 0; i < frames.length; i++) {
      paint(frames[i]!);
      if (i < frames.length - 1) await sleep(delayMs);
    }
  } else {
    await playInPlace(frames, delayMs);
  }
}

export const fourInARowUI: GameUI<FourView> = {
  id: "four",
  title: "Four in a Row",
  // A skill game: Casual only, never staked.
  menu: { label: "Four in a Row", stake: "none", find: true, blurb: "Drop, connect four, win.", players: "2P" },
  completion: "summary",

  // Menu preview: a REAL alternating game — one disc lands per frame, you and Rival taking turns
  // (never two of yours in a row), until your move completes four across the base. Rendered through
  // the real `render` and cycled by the submenu, so the turn note flips your move ↔ their move too.
  preview() {
    const base = { cols: 7, rows: 6, connect: 4, you: "you", opponent: "Rival", youSeat: 0 };
    const mk = (board: number[][], yourTurn: boolean, over = false): FourView => ({
      ...base, board, turn: over ? 1 : 0, yourTurn,
      winner: over ? "you" : null, winningLine: over ? [[1, 0], [2, 0], [3, 0], [4, 0]] : null, complete: over,
    });
    return [
      mk([[], [0], [], [], [], [], []], false),                 // you open column 2 → Rival to move
      mk([[1], [0], [], [], [], [], []], true),                 // Rival answers column 1 → your move
      mk([[1], [0], [0], [], [], [], []], false),               // you take column 3
      mk([[1], [0, 1], [0], [], [], [], []], true),             // Rival stacks column 2
      mk([[1], [0, 1], [0], [0], [], [], []], false),           // you take column 4
      mk([[1, 1], [0, 1], [0], [0], [], [], []], true),         // Rival stacks column 1
      mk([[1, 1], [0, 1], [0], [0], [0], [], []], false, true), // you take column 5 → four across the base, you win
    ];
  },

  initUi(): FourUi {
    return { cursor: 0 };
  },

  boardTitle(_view, ctx) {
    return fourTitle(ctx.room);
  },

  render(view, ctx) {
    const ui = ctx.ui as FourUi;
    return fourBoardLines(view, ctx.nameFor, ctx.myTurn ? ui.cursor : -1);
  },

  controls() {
    return [accent("▶ ←/→ choose column  ·  [enter] drop")];
  },

  onKey(key: Key, view, ctx): KeyResult {
    const ui = ctx.ui as FourUi;
    if (key.name === "left") {
      ui.cursor = (ui.cursor - 1 + view.cols) % view.cols;
      return { handled: true };
    }
    if (key.name === "right") {
      ui.cursor = (ui.cursor + 1) % view.cols;
      return { handled: true };
    }
    if (key.name === "return" || key.name === "space") {
      // Reject a full column locally (the server is still the authority).
      const top = view.board[ui.cursor]?.[view.rows - 1] ?? FOUR_EMPTY;
      if (top !== FOUR_EMPTY) return { handled: true, status: warn("that column is full") };
      return { move: { column: ui.cursor }, status: dim(`you dropped in column ${ui.cursor + 1} — waiting…`) };
    }
    return null;
  },

  isMyTurn(view, playing) {
    return playing && view.yourTurn && !view.complete;
  },

  async onView(prev, next, ctx, paint) {
    const ui = ctx.ui as FourUi;
    // Animate the disc that landed since the previous view (the opponent's or our move).
    if (prev) {
      const drop = findDrop(prev, next);
      if (drop) {
        // Animate against the PREVIOUS board so the disc visibly falls into the gap.
        await play(fourDropFrames(prev, drop.col, drop.seat, ctx.nameFor), 55, ctx.tty, paint);
      }
    }
    // Keep the cursor on a playable column.
    ui.cursor = playableColumn(next, ui.cursor);
    // A winning final view pulses the line a few times before the summary.
    if (next.complete && next.winningLine && next.winningLine.length > 0) {
      const frames: string[] = [];
      for (let f = 0; f < 8; f++) frames.push(fourBoardLines(next, ctx.nameFor, -1, f % 2 === 0).join("\n"));
      await play(frames, 120, ctx.tty, paint);
    }
  },

  summary(view) {
    const headline =
      view.winner === view.you
        ? sparkle("YOU WIN")
        : view.winner === null
          ? warn(bold("DRAW"))
          : neg(bold("YOU LOSE"));
    return [dim("match over"), "", headline, "", dim("[space] play again · [m] menu · [q] quit")];
  },
};
