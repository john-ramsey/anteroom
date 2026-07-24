/**
 * Terminal UI for the Anteroom client — polished, dependency-free ANSI.
 *
 * Colours auto-disable when stdout isn't a TTY (piped/redirected), so the same
 * functions stay readable in logs. Box widths are computed on the VISIBLE length
 * (ANSI escapes stripped), so coloured content still aligns.
 *
 * Renderers use the SEMANTIC colours (accent / accent2 / pos / neg / warn) rather than
 * raw hues, so the user's theme (see settings.ts) flows through the whole app.
 */
import { DEFAULT_COUNTRY, DEFAULT_LAYOUT, DEFAULT_THEME, type BjLayout, type CountryMode, type Theme } from "./settings.ts";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const ESC = "\x1b[";
function sgr(code: string, s: string): string {
  return useColor ? `${ESC}${code}m${s}${ESC}0m` : s;
}
export const bold = (s: string): string => sgr("1", s);
export const dim = (s: string): string => sgr("2", s);
export const red = (s: string): string => sgr("31", s);
export const green = (s: string): string => sgr("32", s);
export const yellow = (s: string): string => sgr("33", s);
export const blue = (s: string): string => sgr("34", s);
export const magenta = (s: string): string => sgr("35", s);
export const cyan = (s: string): string => sgr("36", s);
export const gray = (s: string): string => sgr("90", s);

// --- themeable semantic palette ---------------------------------------------

type ColorFn = (s: string) => string;

/** A foreground colourer from a #rrggbb hex (truecolor). Disabled off-TTY / NO_COLOR.
 *  Closes with a foreground-only reset so it nests safely inside bold/dim. */
function hexFn(hex: string): ColorFn {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return (s) => s;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (s) => (useColor ? `${ESC}38;2;${r};${g};${b}m${s}${ESC}39m` : s);
}

interface Palette {
  primary: ColorFn;
  secondary: ColorFn;
  win: ColorFn;
  lose: ColorFn;
  warn: ColorFn;
}
function buildPalette(t: Theme): Palette {
  return {
    primary: hexFn(t.primary),
    secondary: hexFn(t.secondary),
    win: hexFn(t.win),
    lose: hexFn(t.lose),
    warn: hexFn(t.warn),
  };
}
let PAL: Palette = buildPalette(DEFAULT_THEME);

/** Swap the active theme — call once at startup and whenever the user changes it. */
export function applyTheme(t: Theme): void {
  PAL = buildPalette(t);
}

let LAYOUT: BjLayout = DEFAULT_LAYOUT;
/** Choose the blackjack table layout — "big" cards (default) or "compact" one-liners. */
export function setLayout(l: BjLayout): void {
  LAYOUT = l;
}
/** The active blackjack table layout (read by the blackjack game module). */
export function getLayout(): BjLayout {
  return LAYOUT;
}

let COUNTRY_MODE: CountryMode = DEFAULT_COUNTRY;
/** Set how player country is shown app-wide (the user's setting): "auto" (flag where the
 *  terminal supports it, else a text code), "flag", "code", or "off". */
export function setCountryMode(mode: CountryMode): void {
  COUNTRY_MODE = mode;
}
export function getCountryMode(): CountryMode {
  return COUNTRY_MODE;
}

// Semantic colours. Every renderer uses these instead of raw hues.
export const accent = (s: string): string => PAL.primary(s); // titles, your seat, active turn
export const accent2 = (s: string): string => PAL.secondary(s); // dealer / opponents
export const pos = (s: string): string => PAL.win(s); // win / blackjack
export const neg = (s: string): string => PAL.lose(s); // loss / bust / red suits
export const warn = (s: string): string => PAL.warn(s); // push / countdown warning

// --- untrusted text ---------------------------------------------------------

/**
 * Strip terminal-control bytes from untrusted REMOTE text — player display names, server
 * messages / room codes, leaderboard entries — before it reaches ANY width math, truncation,
 * colouring, toast, or the TTY. These are single-line display fields, so they should carry no
 * control bytes at all: removing the whole C0 range (incl. ESC 0x1b and BEL 0x07), DEL, and the C1
 * range (0x80–0x9f) kills every escape form a hostile value could smuggle in — CSI / OSC / DCS / ST
 * cursor moves, screen clears, OSC-8 hyperlinks, OSC-52 clipboard writes, and prompt spoofing. Our
 * OWN colours are layered on AFTER this (accent()/bold() wrap the already-clean text), so they're
 * untouched. PURE.
 */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** U+FE0F VARIATION SELECTOR-16 — forces emoji (wide) presentation of the preceding base char. */
const VS16 = 0xfe0f;
/** Cap on a single grapheme's zero-width marks, so a clamp can't emit an unbounded code-point run. */
const MAX_ZERO_WIDTH_RUN = 16;

/**
 * Visible width of a string in terminal COLUMNS, ignoring ANSI SGR escapes. This is the SINGLE
 * width oracle the whole UI lays out against — every pad / centre / clamp / box edge — so it must
 * match what the terminal actually draws, not just the code-point count. It is East-Asian-Width
 * aware:
 *   • wide CJK / Hangul / Kana / fullwidth forms and emoji        → 2 columns
 *   • zero-width combining marks, ZWJ, variation selectors        → 0 columns
 *   • a U+FE0F emoji-presentation selector promotes its 1-col base → 2 columns (❤+FE0F → ❤️)
 *   • a regional-indicator (flag) pair                            → 2 columns (the ligature width;
 *     flags are only shown on terminals that draw that ligature — see `detectsFlagSupport`)
 *   • everything else (ASCII, box-drawing, pips, arrows, braille) → 1 column
 *
 * Counting code points alone (the old behaviour) under-measured a CJK name by ~1 col/char and an
 * emoji by 1, which shoved fixed-width rows — and the box's right wall — out of alignment.
 *
 * KNOWN LIMIT: East-Asian-Width *Ambiguous* glyphs (·, —, the box-drawing chars) are counted as 1 —
 * correct on the vast majority of terminals; a CJK-locale terminal set to render Ambiguous as 2
 * would still drift. Keep Ambiguous glyphs out of width-critical borders, or use ASCII there.
 */
export function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  let prev = 0; // display width assigned to the preceding base cell (for VS16 promotion)
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    // U+FE0F (emoji-presentation selector) renders its preceding 1-col base as a 2-col emoji
    // (❤+FE0F → ❤️). Promote rather than count it standalone; VS15 (text presentation) stays narrow.
    if (cp === VS16) {
      if (prev === 1) {
        w += 1;
        prev = 2;
      }
      continue;
    }
    const cw = charWidth(cp);
    w += cw;
    prev = cw;
  }
  return w;
}

/** Display columns for one code point (0 / 1 / 2) — the wcwidth-style ranges this UI needs. */
function charWidth(cp: number): number {
  // Zero-width: combining marks, ZWJ, variation selectors, zero-width / BOM spaces.
  if (cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) //   combining half marks
  )
    return 0;
  // Regional indicators: 1 each, so a flag PAIR is 2 — the ligature width on flag-capable terminals.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 1;
  // Wide (2-col): CJK / Hangul / Kana / fullwidth forms, and emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2329 && cp <= 0x232a) || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Kana … CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat / small forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  )
    return 2;
  return 1;
}

export function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padStartVisible(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/**
 * Clamp a string to at most `width` VISIBLE columns, passing ANSI SGR escapes through uncounted
 * and marking a cut with a trailing "…" + reset (so a clipped colour never bleeds). Strings that
 * already fit are returned unchanged. The width-safety backstop the canvas + the seat-roster row
 * lean on so no renderer can ever push a line past the box border.
 */
export function truncVisible(s: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLen(s) <= width) return s;
  const budget = width - 1; // reserve one column for the ellipsis
  const cps = [...s]; // code points, so we can look ahead for a VS16 selector
  let out = "";
  let count = 0;
  let zeros = 0; // consecutive zero-width marks emitted since the last spacing cell
  let inAnsi = false;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    if (inAnsi) {
      out += ch;
      if (ch === "m") inAnsi = false; // end of an SGR sequence
      continue;
    }
    if (ch === "\x1b") {
      inAnsi = true;
      out += ch;
      continue;
    }
    let w = charWidth(ch.codePointAt(0)!);
    // A U+FE0F selector promotes its 1-col base to a 2-col emoji; charge that up front (look-ahead)
    // so the FE0F we emit next can't retroactively blow the budget after the base is already out.
    if (w === 1 && cps[i + 1]?.codePointAt(0) === VS16) w = 2;
    if (w === 0) {
      // Zero-width mark (combining / ZWJ / variation selector): it adds no columns, but cap a
      // pathological run — otherwise the budget never advances to stop it and a clamp can emit an
      // unbounded code-point stream. Drop marks once the visible budget is full or the run is huge.
      if (count >= budget || zeros >= MAX_ZERO_WIDTH_RUN) continue;
      out += ch;
      zeros++;
      continue;
    }
    // Advance the budget by the glyph's DISPLAY width (matching visibleLen), not by one per code
    // point — else a wide CJK/emoji char (2 cols) emits ~2× the requested columns and shears the
    // box's right wall, the very backstop callers lean on.
    if (count + w > budget) break;
    out += ch;
    count += w;
    zeros = 0;
  }
  // Close any colour that was open at the cut; skip the reset for plain text so it leaves no
  // stray "\x1b[0m" in non-TTY / NO_COLOR output.
  return out + "…" + (out.includes("\x1b") ? "\x1b[0m" : "");
}

/** Thousands-separated chip count, e.g. 1480 → "1,480". */
export function fmtChips(n: number): string {
  return n.toLocaleString("en-US");
}

/** Abbreviate a chip count to k / m / b (1,284,000 → "1.3m") — for tight columns. PURE. */
export function fmtChipsCompact(n: number): string {
  if (n < 1000) return String(n);
  for (const [u, v] of [["b", 1e9], ["m", 1e6], ["k", 1e3]] as const) {
    if (n >= v) {
      const x = n / v;
      return (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, "")) + u;
    }
  }
  return String(n);
}

/** A dim horizontal rule of the given width. */
export function rule(width: number): string {
  return dim("─".repeat(Math.max(0, width)));
}

/** Draw a titled rounded box around the given content lines. */
export function box(title: string, lines: string[]): string {
  const inner = Math.max(visibleLen(title) + 2, ...lines.map(visibleLen), 24);
  // Border widths must all equal `inner + 4` (the body is "│ " + inner + " │").
  const dashes = Math.max(0, inner - visibleLen(title) - 1);
  const top = `╭─ ${bold(title)} ${"─".repeat(dashes)}╮`;
  const body = lines.map((l) => `│ ${padEndVisible(l, inner)} │`);
  const bottom = `╰${"─".repeat(inner + 2)}╯`;
  return [top, ...body, bottom].join("\n");
}

// --- toasts -----------------------------------------------------------------

/**
 * A compact toast notification: a 3-line rounded box tinted by `kind` (win → pos, warn →
 * warn, info → accent) with a leading icon. `message` should be PLAIN text (it's capped and
 * bolded here). The terminal overlays these at the screen's top-right — see `term.toast`.
 */
export function renderToast(message: string, kind: "info" | "win" | "warn" = "info"): string[] {
  const tint = kind === "win" ? pos : kind === "warn" ? warn : accent;
  const icon = kind === "win" ? "✓" : kind === "warn" ? "!" : "●";
  const max = 44;
  // `message` is often untrusted (an opponent name, a server error) — strip terminal-control bytes
  // before it's boxed and painted, so it can't smuggle escape sequences to the TTY (see sanitizeText).
  const raw = `${icon} ${sanitizeText(message)}`;
  const text = visibleLen(raw) > max ? raw.slice(0, max - 1) + "…" : raw;
  const inner = visibleLen(text);
  return [
    tint("╭" + "─".repeat(inner + 2) + "╮"),
    tint("│ ") + bold(text) + tint(" │"),
    tint("╰" + "─".repeat(inner + 2) + "╯"),
  ];
}

// --- effects (rainbow + sparkle) --------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Full-saturation hue (0–360) → RGB. */
function hueToRgb(h: number): [number, number, number] {
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g] = [1, x];
  else if (h < 120) [r, g] = [x, 1];
  else if (h < 180) [g, b] = [1, x];
  else if (h < 240) [g, b] = [x, 1];
  else if (h < 300) [r, b] = [x, 1];
  else [r, b] = [1, x];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Colour each character along a hue gradient, shifted by `offset` (24-bit colour). */
export function rainbow(text: string, offset = 0): string {
  if (!useColor) return text;
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const [r, g, b] = hueToRgb((i * 14 + offset) % 360);
    out += `\x1b[38;2;${r};${g};${b}m${chars[i]}`;
  }
  return out + "\x1b[0m";
}

export function center(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + s + " ".repeat(width - len - left);
}

/** A small monochrome flourish, e.g. for a normal win. */
export const sparkle = (s: string): string => `${dim("◆")} ${pos(bold(s))} ${dim("◆")}`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** The braille spinner cell for `tick` (uncoloured). PURE; shared by the matchmaking spinner
 *  and the "while your model runs" HUD so they animate identically. Wraps for negative ticks. */
export function spinnerCell(tick: number): string {
  return SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length]!;
}

/**
 * A compact coin-flip cell — roughly the size of the braille spinner (3 columns). A token spins
 * about its vertical axis: the front shows the "A", the edge a thin bar, the back an "o". PURE;
 * used for the matchmaking "searching for a table" wait. Wraps for negative ticks.
 */
const COIN_FLIP = ["(A)", " A ", " | ", " o ", "(o)", " o ", " | ", " A "] as const;
export function coinCell(tick: number): string {
  return COIN_FLIP[((tick % COIN_FLIP.length) + COIN_FLIP.length) % COIN_FLIP.length]!;
}
/**
 * Content lines for a "searching…" spinner frame: a braille cell advanced by `tick` plus the
 * label, for painting into the shared canvas on an interval (the matchmaking wait). PURE — the
 * caller owns the timer + the canvas, so the spinner lives inside the full-screen frame instead
 * of scrolling. (Replaces the old line-based `startSpinner`, which didn't fit the TUI.)
 */
export function spinnerLines(label: string, tick: number): string[] {
  return [`${accent(spinnerCell(tick))}  ${dim(`${label}…`)}`];
}

/** m:ss for a sub-hour elapsed/countdown (the matchmaking count-up). */
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Content lines for the matchmaking "searching" frame: a spinner + a live m:ss count-up of how
 * long we've been searching, and — once the server's SOFT [minMs, maxMs] band is known — an
 * "est. wait ~min–max s" range. The range is a band, NOT an exact match time, so the timing of a
 * new opponent's arrival isn't telegraphed. PURE; the caller owns the timer + the canvas.
 */
export function searchingLines(tick: number, elapsedMs: number, band?: { minMs: number; maxMs: number }): string[] {
  const lines = [`${accent(coinCell(tick))}  ${dim("searching for a table")}   ${bold(mmss(elapsedMs))}`];
  if (band) {
    lines.push(dim(`est. wait ~${Math.round(band.minMs / 1000)}–${Math.round(band.maxMs / 1000)}s`));
  }
  return lines;
}

// --- country (flag emoji where the terminal renders them, else a text code) ------

/**
 * Heuristic: does this terminal render flag emoji as a SINGLE 2-column ligature? Many terminals
 * DON'T — they show the two regional-indicator letters, each an emoji-width (2-col) glyph, so a
 * "flag" lands ~4 columns wide while `visibleLen` counts it as 2. In a fixed-width row (the seat
 * roster) that 2-column mismatch shoves the box's right wall out of line — so we ALLOWLIST only the
 * terminals known to draw the real 2-wide ligature and default everything else to a text code.
 * PURE (env in → bool). Extend the list as terminals gain support.
 *
 * NOTE: macOS **Terminal.app** (`Apple_Terminal`) is deliberately EXCLUDED — it does not render the
 * flag ligature (it shows the two letterbox glyphs), which is exactly the misalignment above. iTerm2
 * does render flags. VS Code's terminal does not.
 */
export function detectsFlagSupport(env: Record<string, string | undefined>): boolean {
  const tp = env.TERM_PROGRAM ?? "";
  if (tp === "iTerm.app" || tp === "WezTerm" || tp === "ghostty") return true;
  if (env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID) return true;
  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE) return true;
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN) return true;
  if (env.WT_SESSION) return true; // Windows Terminal
  return false;
}

const FLAG_CAPABLE = detectsFlagSupport(process.env);

/** Resolve the country render style from the user's mode + the terminal's flag capability. PURE. */
export function resolveCountryStyle(mode: CountryMode, capable: boolean): "flag" | "code" | "none" {
  if (mode === "off") return "none";
  if (mode === "flag") return "flag";
  if (mode === "code") return "code";
  return capable ? "flag" : "code"; // auto
}

/** ISO-3166 alpha-2 → flag emoji (regional indicators). */
function flagEmoji(cc: string): string {
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * The country decoration to append after a player's name (note the LEADING space), honoring the
 * user's mode + the terminal's flag capability: a flag emoji, a dim ISO code, or "" (off /
 * missing / invalid). The server only ever sends the 2-letter code; this decides how to show it.
 */
export function countryTag(country?: string): string {
  if (!country) return "";
  const cc = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "XX" || cc === "T1") return "";
  const style = resolveCountryStyle(COUNTRY_MODE, FLAG_CAPABLE);
  if (style === "none") return "";
  return style === "flag" ? ` ${flagEmoji(cc)}` : ` ${dim(cc)}`;
}

// --- cards ------------------------------------------------------------------

export interface Card {
  rank: string;
  suit: "S" | "H" | "D" | "C";
}

export const SUIT: Record<Card["suit"], string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

/** A single playing card as a 4-line mini-box (rank top-left, suit bottom-right).
 *  `null` renders a face-down card (the dealer hole / a not-yet-dealt card). */
export function cardLines(c: Card | null): string[] {
  if (!c) return ["┌────┐", "│ ?? │", "│ ?? │", "└────┘"].map(dim);
  const rank = c.rank === "T" ? "10" : c.rank;
  const isRed = c.suit === "H" || c.suit === "D";
  const tint = isRed ? neg : bold;
  return [
    "┌────┐",
    `│${padEndVisible(rank, 4)}│`,
    `│${padStartVisible(SUIT[c.suit], 4)}│`,
    "└────┘",
  ].map(tint);
}

/** Lay a hand out as side-by-side card boxes → 4 aligned lines. `hidden` appends a
 *  face-down card (the dealer's hole card while the hand is live). */
export function handLines(cards: Card[], hidden = false): string[] {
  const boxes = cards.map((c) => cardLines(c));
  if (hidden) boxes.push(cardLines(null));
  if (boxes.length === 0) return ["", "", "", ""];
  return [0, 1, 2, 3].map((r) => boxes.map((b) => b[r]!).join(" "));
}

/** A full-size playing card (5 lines): rank in two corners, suit centred. */
export function bigCardLines(c: Card | null): string[] {
  if (!c) return ["┌─────┐", "│░░░░░│", "│░░░░░│", "│░░░░░│", "└─────┘"].map(dim);
  const rank = c.rank === "T" ? "10" : c.rank;
  const tint = c.suit === "H" || c.suit === "D" ? neg : bold;
  return [
    dim("┌─────┐"),
    dim("│") + tint(padEndVisible(rank, 5)) + dim("│"),
    dim("│") + tint(center(SUIT[c.suit], 5)) + dim("│"),
    dim("│") + tint(padStartVisible(rank, 5)) + dim("│"),
    dim("└─────┘"),
  ];
}
export function bigHandLines(cards: Card[], hidden = false): string[] {
  const boxes = cards.map((c) => bigCardLines(c));
  if (hidden) boxes.push(bigCardLines(null));
  if (boxes.length === 0) return ["", "", "", "", ""];
  return [0, 1, 2, 3, 4].map((r) => boxes.map((b) => b[r]!).join(" "));
}

/** A hand as a one-line row of coloured `[A♠]` brackets (the compact layout). */
export function bracketHand(cards: Card[], hidden = false): string {
  const parts = cards.map((c) => {
    const rank = c.rank === "T" ? "10" : c.rank;
    const tint = c.suit === "H" || c.suit === "D" ? neg : bold;
    return tint(`[${rank}${SUIT[c.suit]}]`);
  });
  if (hidden) parts.push(dim("[ ?]"));
  return parts.join(" ");
}

// --- dice (pip faces) -------------------------------------------------------

/** Pip layout per die face: a 3×3 grid of on/off dots. */
const PIPS: Record<number, number[][]> = {
  1: [[0, 0, 0], [0, 1, 0], [0, 0, 0]],
  2: [[1, 0, 0], [0, 0, 0], [0, 0, 1]],
  3: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  4: [[1, 0, 1], [0, 0, 0], [1, 0, 1]],
  5: [[1, 0, 1], [0, 1, 0], [1, 0, 1]],
  6: [[1, 0, 1], [1, 0, 1], [1, 0, 1]],
};

/** A single 6-face die as a 5-line pip box. `hot` tints the pips win-green. Shared by dice games. */
export function dieLines(n: number, hot = false): string[] {
  const pips = PIPS[n] ?? PIPS[1]!;
  const tint = hot ? pos : bold;
  return [
    dim("┌─────────┐"),
    ...pips.map((row) => dim("│ ") + row.map((p) => (p ? tint("●") : " ")).join("  ") + dim(" │")),
    dim("└─────────┘"),
  ];
}

/** Two dice side by side → 5 aligned lines. */
export function diceLines(roll: [number, number], hot = false): string[] {
  const left = dieLines(roll[0], hot);
  const right = dieLines(roll[1], hot);
  return left.map((l, i) => `${l}   ${right[i]}`);
}

// --- leaderboard ------------------------------------------------------------

export interface LeaderRow {
  rank: number;
  userId: string;
  name: string;
  balance: number;
  wins: number;
  losses: number;
}

/** Top ranks tinted (gold / silver / bronze), the rest dim. */
function rankBadge(rank: number): string {
  const s = String(rank);
  if (rank === 1) return warn(bold(s));
  if (rank === 2) return bold(s);
  if (rank === 3) return neg(s);
  return dim(s);
}

/** Leaderboard ordering: `chips` = balance (default); `wl` = wins, then fewer losses, then chips. */
export type LeaderboardSort = "chips" | "wl";

/** The marker sitting with the active sort column's header — a non-color signal (so the active
 *  sort reads even under NO_COLOR / for color-blind users), paired with the accent highlight. */
export const SORT_CARET = "▾";

/** Style a header cell: the active sort column pops in the accent color, the rest stay dim. */
function colorHead(cell: string, active: boolean): string {
  return active ? accent(cell) : dim(cell);
}

/**
 * The leaderboard table as content LINES (no box — the shell frames it in the canvas; the
 * standalone `--leaderboard` print wraps it via `box`). `selfId`, when given, marks the
 * viewer's own row: a cyan `▸` gutter, the name in cyan, and a dim "(you)" tag — so you can
 * spot yourself at a glance. `sort`, when given, marks which column is the active ranking (a
 * caret + accent on CHIPS or W–L) — it's an INTERACTIVE affordance, so static prints (the CLI
 * `--leaderboard`, the marketing capture) omit it and render exactly as before. Each row's
 * `name` is the server-provided display username.
 */
export function renderLeaderboard(
  rows: LeaderRow[],
  selfId?: string,
  width?: number,
  sort?: LeaderboardSort,
): string[] {
  if (rows.length === 0) {
    return [dim("no players yet — be the first to win some chips")];
  }
  // Given a width budget (the canvas CW) the table is responsive; without one it keeps the fixed
  // layout (the standalone `--leaderboard` print and width-agnostic callers).
  if (width !== undefined) return responsiveLeaderboard(rows, width, selfId, sort);
  const chipsHead = sort === "chips" ? `CHIPS ${SORT_CARET}` : "CHIPS";
  const wlHead = sort === "wl" ? `W–L ${SORT_CARET}` : "W–L";
  const header = `  ${dim(padEndVisible("#", 3))} ${dim(padEndVisible("PLAYER", 22))} ${colorHead(padStartVisible(chipsHead, 9), sort === "chips")}  ${colorHead(wlHead, sort === "wl")}`;
  const body = rows.map((e) => {
    const isSelf = selfId !== undefined && e.userId === selfId;
    const marker = isSelf ? accent(bold("▸")) : " ";
    const rank = padEndVisible(rankBadge(e.rank), 3);
    // The name is the server-provided display username (untrusted) — strip control bytes first.
    const raw = sanitizeText(e.name).slice(0, 16);
    const name = isSelf ? `${accent(bold(raw))} ${dim("(you)")}` : raw;
    const who = padEndVisible(name, 22);
    const chips = padStartVisible(bold(fmtChips(e.balance)), 9);
    const wl = `${pos(String(e.wins))}${dim("–")}${neg(String(e.losses))}`;
    return `${marker} ${rank} ${who} ${chips}  ${wl}`;
  });
  const w = Math.max(visibleLen(header), ...body.map((l) => visibleLen(l)));
  return [header, rule(w), ...body];
}

const LEADERBOARD_MAX_NAME = 26; // cap PLAYER so a wide canvas keeps the table centred, not sprawling
const LEADERBOARD_ABBREV_BELOW = 66; // below this width chip counts abbreviate (k/m/b) to save room

/** The width-aware leaderboard: PLAYER grows with the canvas but is capped (so a wide canvas centres
 *  the table rather than spanning it); CHIPS + W–L are right-aligned and never clip — the name
 *  truncates first; on a narrow canvas the chip counts abbreviate to k/m/b. The active-sort caret
 *  is folded into the column-width budget so header + body stay aligned and the row never overflows
 *  the canvas. PURE. */
function responsiveLeaderboard(
  rows: LeaderRow[],
  width: number,
  selfId?: string,
  sort?: LeaderboardSort,
): string[] {
  const chip = width < LEADERBOARD_ABBREV_BELOW ? fmtChipsCompact : fmtChips;
  const chipsHead = sort === "chips" ? `CHIPS ${SORT_CARET}` : "CHIPS";
  const wlHead = sort === "wl" ? `W–L ${SORT_CARET}` : "W–L";
  const CHIPS_W = Math.max(chipsHead.length, ...rows.map((e) => chip(e.balance).length));
  const WL_W = Math.max(wlHead.length, ...rows.map((e) => `${e.wins}–${e.losses}`.length));
  const fixed = 1 + 1 + 3 + 1 + 1 + CHIPS_W + 2 + WL_W; // marker+sp rank+sp sp chips 2sp wl
  const nameW = Math.max(6, Math.min(width - fixed, LEADERBOARD_MAX_NAME));
  const header = `  ${dim(padEndVisible("#", 3))} ${dim(padEndVisible("PLAYER", nameW))} ${colorHead(padStartVisible(chipsHead, CHIPS_W), sort === "chips")}  ${colorHead(padStartVisible(wlHead, WL_W), sort === "wl")}`;
  const body = rows.map((e) => {
    const isSelf = selfId !== undefined && e.userId === selfId;
    const marker = isSelf ? accent(bold("▸")) : " ";
    const rank = padEndVisible(rankBadge(e.rank), 3);
    const raw = truncVisible(sanitizeText(e.name), Math.max(1, isSelf ? nameW - 6 : nameW));
    const name = isSelf ? `${accent(bold(raw))} ${dim("(you)")}` : raw;
    const who = padEndVisible(name, nameW);
    const chips = padStartVisible(bold(chip(e.balance)), CHIPS_W);
    const wl = padStartVisible(`${pos(String(e.wins))}${dim("–")}${neg(String(e.losses))}`, WL_W);
    return `${marker} ${rank} ${who} ${chips}  ${wl}`;
  });
  const w = Math.max(visibleLen(header), ...body.map((l) => visibleLen(l)));
  return [header, rule(w), ...body];
}

// --- animations -------------------------------------------------------------

/**
 * Play a sequence of (multi-line) frames in place: redraw each over the previous
 * using cursor-up + line-clear. Off-TTY / under NO_COLOR it just prints the final
 * frame once, so logs and tests stay clean. The final frame is left on screen.
 */
export async function playInPlace(frames: string[], delayMs = 90): Promise<void> {
  if (frames.length === 0) return;
  if (!useColor) {
    console.log(frames[frames.length - 1]);
    return;
  }
  let prevHeight = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) process.stdout.write(`\x1b[${prevHeight}A`);
    const lines = frames[i]!.split("\n");
    const height = Math.max(lines.length, prevHeight); // overwrite any taller previous frame
    for (let l = 0; l < height; l++) process.stdout.write(`\r\x1b[2K${lines[l] ?? ""}\n`);
    prevHeight = height;
    if (i < frames.length - 1) await sleep(delayMs);
  }
}

/**
 * Drive a per-game transition animation: paint each (multi-line) board frame into the shared
 * canvas via `paint`, sleeping `delayMs` between frames. Off a TTY it falls back to
 * `playInPlace` (prints the final frame once), so logs/tests stay clean. This is the ONE place
 * a `GameUI.onView` should funnel its frames through — keeping the TTY/non-TTY branch in a
 * single tested spot so a game can't half-wire (and silently drop) its animation.
 */
export async function animateFrames(
  frames: string[],
  delayMs: number,
  tty: boolean,
  paint: (body: string) => void,
): Promise<void> {
  if (frames.length === 0) return;
  if (!tty) {
    await playInPlace(frames, delayMs);
    return;
  }
  for (let i = 0; i < frames.length; i++) {
    paint(frames[i]!);
    if (i < frames.length - 1) await sleep(delayMs);
  }
}

/**
 * Frames that count a chip balance from `from` to `to` (a settlement tally). The
 * `label` (e.g. "settlement: you +50") is held fixed while the number ticks.
 */
export function tallyFrames(label: string, from: number, to: number): string[] {
  const steps = 10;
  const frames: string[] = [];
  for (let i = 1; i <= steps; i++) {
    const cur = Math.round(from + (to - from) * (i / steps));
    frames.push(`${label}  ${dim("→")}  ${bold(String(cur))} chips`);
  }
  frames[frames.length - 1] = `${label}  ${dim("→")}  ${bold(String(to))} chips`;
  return frames;
}

// --- menu + summary ---------------------------------------------------------

/** A vertical menu's content LINES with one highlighted row (an optional dim subtitle on top), a
 *  blank row between items so the list breathes, and every row padded to a common width so the
 *  canvas centres them as ONE aligned block (a shared left edge) rather than centring each
 *  ragged-width row on its own. The shell frames it in the shared canvas; the help line is the
 *  canvas note. (Lists here are short — category / stake / buy-in — so the spacing fits.) */
export function renderMenu(items: string[], selected: number, subtitle?: string): string[] {
  const rows = items.map((label, i) => {
    const sel = i === selected;
    return `${sel ? accent(bold("▸")) : " "} ${sel ? accent(bold(label)) : label}`;
  });
  const w = Math.max(0, ...rows.map(visibleLen));
  const lines: string[] = [];
  if (subtitle) lines.push(center(dim(subtitle), w), "");
  rows.forEach((r, i) => {
    if (i > 0) lines.push("");
    lines.push(padEndVisible(r, w));
  });
  return lines;
}

/** Lifetime stats to surface on the end-of-match screen (from the leaderboard). */
export interface Lifetime {
  wins: number;
  losses: number;
  rank?: number;
  balance?: number;
}
