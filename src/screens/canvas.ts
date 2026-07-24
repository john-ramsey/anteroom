/**
 * The shared full-screen canvas every screen renders into.
 *
 * Promoted out of the intro so the menu, a game session, settings, the summary, the
 * leaderboard, the finding-players spinner, the account screen, and the intro all draw
 * into the SAME aspect-locked, letter-boxed box — so there's no size jump as you move
 * between screens. Screens stay pure string-builders: they hand `frame()`/`screen()` a
 * title + an array of content lines (and an optional bottom note); the canvas centres
 * the content, reserves the bottom row for the note, and centres the whole box in the
 * terminal.
 *
 * scripts/ui-demo.ts (the visual reference, `npm run demo`) imports this module directly, so
 * the demo and the app share one canvas — no copy to keep in sync.
 */
import { bold, center, dim, padEndVisible, truncVisible, visibleLen } from "../ui.ts";
import type { Terminal } from "../terminal.ts";

export interface Geom {
  CW: number;
  CH: number;
  COLS: number;
  ROWS: number;
}

/** The largest 3.5:1 (≈16:9 visual) box that fits the terminal, with a sensible floor. */
export function sizeCanvas(term: Terminal): Geom {
  const COLS = term.columns || 80;
  const ROWS = term.rows || 30;
  const RATIO = 3.5;
  const MIN_W = 58;
  const MIN_H = 20;
  // Hard ceilings: the drawn box is CW+4 wide and CH+2 tall (borders), so it must fit inside the
  // terminal or the right edge overflows / the top scrolls off. These caps WIN over the MIN floor —
  // on a terminal too small for the preferred minimum we shrink below it rather than overrun.
  //
  // capW reserves 6 cols (≥1 of horizontal LEAD on each side after centring): the box must NEVER be
  // as wide as the terminal. A box of exactly COLS puts its right wall in the terminal's LAST column,
  // and the near-universal auto-margin (VT100 "last column" quirk) drops that final glyph or wraps
  // the cursor — so the right border vanishes / the whole frame shears. Seen at COLS=141 (CW would be
  // 137 → box 141 → no right wall). Keeping box ≤ COLS−2 guarantees the wall is always drawn.
  const capW = Math.max(8, COLS - 6);
  const capH = Math.max(6, ROWS - 2);
  let CH = Math.min(capH, Math.round(capW / RATIO));
  let CW = Math.round(CH * RATIO);
  if (CW > capW) {
    CW = capW;
    CH = Math.round(CW / RATIO);
  }
  // Prefer at least MIN_W×MIN_H, but never exceed the terminal-fit caps.
  return {
    CW: Math.min(Math.max(CW, MIN_W), capW),
    CH: Math.min(Math.max(CH, MIN_H), capH),
    COLS,
    ROWS,
  };
}

/**
 * A full-screen frame: a titled CW×CH box, content vertically centred, a dim note on the
 * bottom row, the whole box letter-boxed (centred) in the terminal. Lines that fit within the
 * canvas width are centred horizontally; an over-wide line is CLAMPED to CW (ellipsis) so it can
 * never push the right border out — the box stays rectangular no matter what a screen emits.
 *
 * PURE — returns the framed multi-line string (no I/O), so it's unit-testable.
 */
export function frame(g: Geom, title: string, content: string[], note = ""): string {
  const { CW, CH, COLS, ROWS } = g;
  const rows: string[] = Array.from({ length: CH }, () => "");
  const area = CH - 1; // bottom row reserved for the note
  const start = Math.max(0, Math.floor((area - content.length) / 2));
  for (let i = 0; i < content.length; i++) {
    const r = start + i;
    if (r >= 0 && r < area) rows[r] = content[i] ?? "";
  }
  // The note row is the one FIXED slot (always reserved, whether or not a note is shown), so the
  // session routes ephemeral status here to keep the board from shifting. A plain hint is dimmed
  // (the default); an already-coloured status (pos/neg/warn/tally) passes through with its own
  // colour intact rather than being wrapped in dim (whose mid-string resets would corrupt it).
  if (note) rows[CH - 1] = note.includes("\x1b[") ? note : dim(note);
  // Clamp the TITLE too: the top border is `╭─ <title> <dashes>╮`, and with the 4 cols of chrome
  // ("╭─ ", " ", "╮") the title field is CW−4 at most. Without this clamp a long boardTitle pushes
  // the ╮ past the body's right wall — the same box-break the body clamp below prevents, but on the
  // top edge. Truncating here keeps the top border exactly CW+4 wide for ANY title.
  const safeTitle = truncVisible(title, Math.max(0, CW - 4));
  const dashes = Math.max(0, CW - visibleLen(safeTitle) - 1);
  // Clamp first (a too-wide line would otherwise overrun the right border and break the box),
  // then centre+pad to exactly CW so every body line is the same width.
  const body = rows.map((l) => `│ ${padEndVisible(center(truncVisible(l, CW), CW), CW)} │`);
  const lines = [`╭─ ${bold(safeTitle)} ${"─".repeat(dashes)}╮`, ...body, `╰${"─".repeat(CW + 2)}╯`];
  const lead = " ".repeat(Math.max(0, Math.floor((COLS - (CW + 4)) / 2)));
  const top = Math.max(0, Math.floor((ROWS - lines.length) / 2));
  return [...Array.from({ length: top }, () => ""), ...lines.map((l) => lead + l)].join("\n");
}

/**
 * Size the canvas to the live terminal, build a full-screen frame, and paint it. The
 * one call every screen uses so they're all the same size. Returns the painted string
 * (handy for tests / non-TTY callers).
 */
export function screen(term: Terminal, title: string, content: string[], note = ""): string {
  const out = frame(sizeCanvas(term), title, content, note);
  term.paint(out);
  return out;
}
