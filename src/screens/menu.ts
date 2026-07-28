/**
 * The main menu and its sub-screens (stake select, leaderboard, account). Pure keyboard
 * navigation rendered into the shared full-screen canvas. Returns a `MenuAction` the app
 * shell acts on; after any game the shell comes back here.
 *
 * The game rows are DATA-DRIVEN from the client game registry (`listGameUIs()`) — there is
 * NO hand-numbered switch and no hardcoded game list. A new game appears in the menu the
 * moment it's registered, with its stake prompt + matchmaking driven by its `menu` spec.
 */
import type { Key, Terminal } from "../terminal.ts";
import { fetchLeaderboard } from "../net.ts";
import { accent, bold, center, dim, padEndVisible, renderLeaderboard, sanitizeText, truncVisible, visibleLen, type LeaderboardSort } from "../ui.ts";
import { screen, sizeCanvas, type Geom } from "./canvas.ts";
import { getGameUI, listGameUIs } from "./games/registry.ts";
import type { GameCtx, GameUI } from "./games/types.ts";

export type MenuAction =
  | { type: "play"; game: string; ante: number; find: boolean }
  // Join a specific room by code (a friend's table): take an open seat, else spectate read-only.
  | { type: "joinRoom"; code: string }
  | { type: "leaderboard" }
  | { type: "account" }
  | { type: "settings" }
  | { type: "quit" };

/** The slice of a game UI the menu needs (keeps `buildMenuRows` pure + trivially testable). */
export type MenuGame = Pick<GameUI, "id" | "title" | "menu">;
type TailAction = "joinRoom" | "leaderboard" | "account" | "settings" | "quit";
/** The two game categories a `submenu` row drills into. */
export type Category = typeof SECTION_CASUAL | typeof SECTION_STAKES;

/** A row in the sectioned home menu. Headers and the divider are non-selectable. */
export type MenuRow =
  | { kind: "header"; label: string }
  | { kind: "rule" }
  | {
      kind: "game";
      label: string;
      id: string;
      title: string;
      stake: GameUI["menu"]["stake"];
      defaultStake?: number;
      find: boolean;
    }
  // A drill-in entry under "Play" that opens the Casual or Stakes game list.
  | { kind: "submenu"; label: string; section: Category }
  | { kind: "action"; label: string; action: TailAction };

/** Section names: friendly games that never stake vs. games you play for chips. */
export const SECTION_CASUAL = "Casual";
export const SECTION_STAKES = "Stakes";
/** Home-menu section headers: the recently-played shortlist, and the browse-by-category group. */
export const SECTION_RECENT = "Recent";
export const SECTION_PLAY = "Play";
/** How many recent games the home menu surfaces (the rest stay on disk for ordering). */
export const RECENT_SHOWN = 2;

const TAIL: { label: string; action: TailAction }[] = [
  { label: "Join Room", action: "joinRoom" },
  { label: "Leaderboard", action: "leaderboard" },
  { label: "Account", action: "account" },
  { label: "Settings", action: "settings" },
  { label: "Quit", action: "quit" },
];

/** A `game` row built from a registered game (a Recent shortcut — plays directly, stake prompt and all). */
function gameRow(g: MenuGame): MenuRow {
  return {
    kind: "game",
    label: g.menu.label,
    id: g.id,
    title: g.title,
    stake: g.menu.stake,
    defaultStake: g.menu.defaultStake,
    find: g.menu.find,
  };
}

/** The games in a category, in registry order. */
export function categoryGames(games: MenuGame[], section: Category): MenuGame[] {
  return games.filter((g) => (section === SECTION_CASUAL ? g.menu.stake === "none" : g.menu.stake !== "none"));
}

/**
 * Build the home menu rows: an optional "Recent" section (up to `RECENT_SHOWN` distinct, registered
 * games, most-recent-first — omitted entirely when there are none), a "Play" section whose entries
 * drill into the Casual / Stakes game lists, then a divider and the tail actions. The games
 * themselves no longer live on the home screen; they're reached via Recent or the category submenus.
 * Pure.
 */
export function buildMenuRows(games: MenuGame[], recent: string[] = []): MenuRow[] {
  const rows: MenuRow[] = [];
  const byId = new Map(games.map((g) => [g.id, g]));

  // Recent: map stored ids to registered games (dropping unknown/unregistered ones), cap to the
  // shortlist. Omitted (no header) until at least one game has been played.
  const recentGames = recent
    .map((id) => byId.get(id))
    .filter((g): g is MenuGame => g !== undefined)
    .slice(0, RECENT_SHOWN);
  if (recentGames.length > 0) {
    rows.push({ kind: "header", label: SECTION_RECENT });
    for (const g of recentGames) rows.push(gameRow(g));
  }

  // Play: one drill-in entry per non-empty category.
  const categories = ([SECTION_CASUAL, SECTION_STAKES] as Category[]).filter(
    (s) => categoryGames(games, s).length > 0,
  );
  if (categories.length > 0) {
    rows.push({ kind: "header", label: SECTION_PLAY });
    for (const s of categories) rows.push({ kind: "submenu", label: s, section: s });
  }

  rows.push({ kind: "rule" });
  for (const t of TAIL) rows.push({ kind: "action", label: t.label, action: t.action });
  return rows;
}

/** Indices of the rows a cursor may land on (games, submenus, actions; never headers/rules). */
export function selectableIndices(rows: MenuRow[]): number[] {
  return rows.flatMap((r, i) =>
    r.kind === "game" || r.kind === "submenu" || r.kind === "action" ? [i] : [],
  );
}

/** The next selectable row index in `dir` (+1 down / −1 up), wrapping and skipping headers/rules. */
export function nextSelectable(rows: MenuRow[], current: number, dir: 1 | -1): number {
  const sel = selectableIndices(rows);
  if (sel.length === 0) return current;
  const pos = sel.indexOf(current);
  if (pos === -1) return sel[0]!;
  return sel[(pos + dir + sel.length) % sel.length]!;
}

/** Render the sectioned menu rows into canvas lines (pure string builder). A blank line precedes
 *  each section header + the divider so the groups breathe, and every line is padded to a common
 *  width so the canvas centres them as ONE aligned block (a shared left edge) instead of centring
 *  each ragged-width line on its own (which read as "not middle justified"). */
export function renderMenuRows(rows: MenuRow[], selected: number, subtitle?: string): string[] {
  const rendered: string[] = [];
  rows.forEach((row, i) => {
    if (row.kind === "header") {
      if (rendered.length > 0) rendered.push(""); // breathing room above each section
      rendered.push(dim(`── ${row.label} ${"─".repeat(Math.max(2, 22 - row.label.length))}`));
    } else if (row.kind === "rule") {
      if (rendered.length > 0) rendered.push("");
      rendered.push(dim("─".repeat(26)));
    } else {
      const sel = i === selected;
      // A submenu entry carries a trailing chevron (it drills into a category); games/actions don't.
      const text = row.kind === "submenu" ? `${row.label.padEnd(18)}›` : row.label;
      rendered.push(`${sel ? accent(bold("▸")) : " "} ${sel ? accent(bold(text)) : text}`);
    }
  });
  const w = Math.max(0, ...rendered.map(visibleLen));
  const body = rendered.map((l) => padEndVisible(l, w));
  return subtitle ? [center(dim(subtitle), w), "", ...body] : body;
}

/** The stake style as a short submenu tag. */
function stakeTag(stake: GameUI["menu"]["stake"]): string {
  if (stake === "wager") return "wager";
  if (stake === "buyin") return "buy-in";
  if (stake === "bankroll") return "bankroll";
  return "casual";
}

/**
 * The COMPACT left column: just each game's name (one row each) and a "Back" row — used when
 * the detailed list wouldn't leave the preview panel room to show the section's boards uncut.
 * The dropped detail (stake · players — blurb) moves UNDER the preview box (see
 * `composeCategoryScreen`), so nothing is lost — it changes address. Pure.
 */
export function categoryCompactLines(games: MenuGame[], sel: number): string[] {
  const lines = games.map((g, i) => {
    const on = i === sel;
    return `${on ? accent(bold("▸ ")) : "  "}${on ? accent(bold(g.menu.label)) : g.menu.label}`;
  });
  const backOn = sel >= games.length;
  lines.push("", `${backOn ? accent(bold("▸ ")) : "  "}${backOn ? accent(bold("Back")) : "Back"}`);
  return lines;
}

/**
 * The DETAILED left column for a category submenu: each game as a name + a dim `stake · players`
 * line + a dim one-line blurb, separated by a blank, then a "Back" row. The selected row's name
 * carries the accent ▸ cursor; `sel` ranges 0..games.length (games.length === the Back row). Pure.
 */
export function categoryLeftLines(games: MenuGame[], sel: number): string[] {
  const lines: string[] = [];
  games.forEach((g, i) => {
    if (i > 0) lines.push("");
    const on = i === sel;
    lines.push(`${on ? accent(bold("▸ ")) : "  "}${on ? accent(bold(g.menu.label)) : bold(g.menu.label)}`);
    lines.push(`  ${dim(`${stakeTag(g.menu.stake)} · ${g.menu.players}`)}`);
    lines.push(`  ${dim(g.menu.blurb)}`);
  });
  lines.push("");
  const backOn = sel >= games.length;
  lines.push(`${backOn ? accent(bold("▸ ")) : "  "}${backOn ? accent(bold("Back")) : "Back"}`);
  return lines;
}

/** Two side-by-side blocks as canvas content lines: each vertically centred to a common height,
 *  then joined with `gap` spaces. EVERY line is padded to the same total width (left + gap + right)
 *  so the canvas centres the whole block as one unit — otherwise a row with an empty right side
 *  would be centred on its own (shorter) width and the left edge would wobble. Pure (testable). */
export function composeColumns(left: string[], right: string[], gap = 3): string[] {
  const h = Math.max(left.length, right.length);
  const pad = (arr: string[]): string[] => {
    const top = Math.floor((h - arr.length) / 2);
    const bottom = Math.max(0, h - arr.length - top);
    return [...Array.from({ length: top }, () => ""), ...arr, ...Array.from({ length: bottom }, () => "")];
  };
  const L = pad(left);
  const R = pad(right);
  const leftW = Math.max(0, ...left.map(visibleLen));
  const rightW = Math.max(0, ...right.map(visibleLen));
  const sp = " ".repeat(gap);
  return L.map((l, i) => padEndVisible(`${padEndVisible(l, leftW)}${sp}${R[i] ?? ""}`, leftW + gap + rightW));
}

/** Pad every line of a game's preview frames to that game's OWN widest line (clamped to `cap`), so
 *  the widest line is IDENTICAL in every frame. `fixedBox` block-centres each frame by its widest
 *  line, so without this a frame whose content is narrower (a shorter turn note, fewer cards dealt)
 *  would re-centre and the whole board would slide sideways as the frames cycle — a container that
 *  reflows per frame is jarring UI. Uniform per-game width ⇒ the board sits at a FIXED offset. Pure. */
export function stabilizeFrameWidths(frames: string[][], cap: number): string[][] {
  const w = Math.min(cap, Math.max(1, ...frames.flat().map((l) => visibleLen(l))));
  return frames.map((f) => f.map((l) => padEndVisible(truncVisible(l, w), w)));
}

/** Server room-code alphabet (no ambiguous 0/o/1/l). */
const ROOM_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** A realistic 6-char room code (chosen once per launch) so preview boards read like a real table
 *  instead of a "DEMO" placeholder — the same length/alphabet the server allocates. */
const PREVIEW_ROOM = Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join("");

/** A minimal GameCtx for rendering a side-panel preview (no live session). */
function previewCtx(ui: GameUI): GameCtx {
  return { room: PREVIEW_ROOM, nameFor: (id) => id, myId: "you", myTurn: false, ui: ui.initUi ? ui.initUi() : {}, lastDeltas: undefined, tty: false };
}

/** Comfortable separation between the list (left) and the preview panel (right). The two-column
 *  block is a FIXED moderate width (list + this gap + box) that the canvas then centres, so it sits
 *  inset from both edges rather than stretched wall-to-wall on a wide terminal. */
const PREVIEW_GAP = 8;
/** How long each preview frame holds — quick enough to feel alive, slow enough not to flicker. */
const PREVIEW_FRAME_MS = 500;
/** Extra width/height the box carries beyond the widest/tallest frame, so the board sits INSET from
 *  the borders (a few columns / a row of breathing room each side) rather than touching them. */
const PREVIEW_HPAD = 6;
const PREVIEW_VPAD = 2;

/**
 * A FIXED-size preview panel: `content` is block-centred into a constant `innerW`×`innerH` box
 * (clipped if larger, padded if smaller) and framed. The dimensions DO NOT depend on the content,
 * so the box NEVER changes size as frames cycle or the selection moves — a hard rule (a container
 * that resizes per frame is jarring UI). Pure (testable).
 */
export function fixedBox(title: string, content: string[], innerW: number, innerH: number): string[] {
  const lines = content.map((l) => truncVisible(l, innerW));
  const bw = Math.max(0, ...lines.map((l) => visibleLen(l)));
  const lead = " ".repeat(Math.max(0, Math.floor((innerW - bw) / 2)));
  const centred = lines.map((l) => padEndVisible(lead + l, innerW));
  const top = Math.max(0, Math.floor((innerH - centred.length) / 2));
  const rows: string[] = [];
  for (let r = 0; r < innerH; r++) {
    const idx = r - top;
    rows.push(idx >= 0 && idx < centred.length ? centred[idx]! : " ".repeat(innerW));
  }
  const safeTitle = truncVisible(title, Math.max(0, innerW - 2));
  const dashes = Math.max(0, innerW - visibleLen(safeTitle) - 1);
  return [`╭─ ${bold(safeTitle)} ${"─".repeat(dashes)}╮`, ...rows.map((r) => `│ ${r} │`), `╰${"─".repeat(innerW + 2)}╯`];
}

/** Either single-column (off-TTY / a terminal too small for even the compact layout) or
 *  two-column with a FIXED preview box. `compact` = the left list collapsed to names-only so the
 *  panel could fit the section's boards (the per-game detail moves under the box). Every game's
 *  preview frames are pre-rendered ONCE so the box is sized to fit the widest board across the
 *  whole section and then NEVER resizes; the gap is widened to push the list left + preview right. */
export type CategoryLayout =
  | { twoCol: false }
  | {
      twoCol: true;
      compact: boolean;
      gap: number;
      innerW: number;
      innerH: number;
      framesByGame: string[][][];
      /** Per-game frame cadence: a game with a real preview ANIMATION (`previewFrames`, e.g.
       *  the roulette spin) ticks at its own ms; view-snapshot previews at the default. */
      msByGame: number[];
    };

interface SectionPreviews {
  rendered: string[][][];
  msByGame: number[];
  sectionMaxW: number;
  maxFrameLines: number;
}

/** The rendered preview frames + their section-wide measurements are geometry-independent
 *  (pure string boards, no terminal size in the ctx), so they're computed once per section and
 *  reused across resize events / submenu re-entries instead of re-rendering every board. */
const sectionPreviewCache = new Map<string, SectionPreviews>();

function sectionPreviews(games: MenuGame[]): SectionPreviews {
  const key = games.map((g) => g.id).join(",");
  const hit = sectionPreviewCache.get(key);
  if (hit) return hit;
  // Each game's frames, through whichever seam it exposes: a pre-rendered animation
  // (`previewFrames`, at its own cadence) or view snapshots through the real renderer.
  const msByGame: number[] = [];
  const rendered = games.map((gm) => {
    const ui = getGameUI(gm.id);
    const ctx = previewCtx(ui);
    const pf = ui.previewFrames?.(ctx);
    msByGame.push(pf?.ms ?? PREVIEW_FRAME_MS);
    return pf ? pf.frames : (ui.preview?.() ?? []).map((v) => ui.render(v, ctx));
  });
  const entry = {
    rendered,
    msByGame,
    sectionMaxW: Math.max(1, ...rendered.flat(2).map((l) => visibleLen(l))),
    maxFrameLines: Math.max(1, ...rendered.flat().map((f) => f.length)),
  };
  sectionPreviewCache.set(key, entry);
  return entry;
}

/**
 * Pick the layout by a LADDER, never clamping a board: every board is authored to fit the
 * 58-col canvas floor, so when the panel can't hold the section it's the LIST that yields —
 * (1) the detailed list beside the panel when both fit; (2) the compact names-only list (the
 * detail line moves under the box) when that's what it takes; (3) single-column (no panel)
 * only when even compact can't show the whole animation. A partially shown board ("…") is
 * never an outcome.
 */
export function buildCategoryLayout(term: Terminal, games: MenuGame[]): CategoryLayout {
  if (!term.tty) return { twoCol: false };
  const g: Geom = sizeCanvas(term);
  const { rendered, msByGame, sectionMaxW, maxFrameLines } = sectionPreviews(games);
  // The panel's height budget: the box (innerH + 2 borders) + the compact detail row must fit
  // the canvas area, so cap innerH at CH − 4 in both modes (detailed simply leaves a spare row).
  const innerH = Math.min(Math.max(6, g.CH - 4), maxFrameLines + PREVIEW_VPAD);
  if (maxFrameLines > innerH) return { twoCol: false };

  const layoutFor = (leftLines: string[], compact: boolean): CategoryLayout | null => {
    const leftW = Math.max(0, ...leftLines.map((l) => visibleLen(l)));
    const budgetW = g.CW - leftW - PREVIEW_GAP - 4; // 4 = the box borders
    if (sectionMaxW > budgetW) return null; // the widest board would be clamped — not this rung
    const innerW = Math.min(budgetW, sectionMaxW + PREVIEW_HPAD);
    // Pad each game's frames to that game's OWN constant width so the board never slides sideways
    // as frames cycle (cards dealing, discs landing, a shorter turn note must not reflow the layout).
    const framesByGame = rendered.map((frames) => stabilizeFrameWidths(frames, innerW));
    return { twoCol: true, compact, gap: PREVIEW_GAP, innerW, innerH, framesByGame, msByGame };
  };

  return (
    layoutFor(categoryLeftLines(games, 0), false) ??
    layoutFor(categoryCompactLines(games, 0), true) ?? { twoCol: false }
  );
}

/**
 * Compose the full category-submenu content for a selection + animation frame: the (detailed or
 * compact) list on the left, the fixed preview box on the right — and, in compact mode, the
 * selected game's detail line (`stake · players — blurb`) as a constant row UNDER the box (blank
 * on Back), so the box never moves as the cursor travels. Pure — the live submenu AND the UI
 * demo both drive this one seam, so the showcase can't drift from the shipped layout.
 */
export function composeCategoryScreen(layout: CategoryLayout, games: MenuGame[], sel: number, frameI: number): string[] {
  if (!layout.twoCol) return categoryLeftLines(games, sel);
  const left = layout.compact ? categoryCompactLines(games, sel) : categoryLeftLines(games, sel);
  const onGame = sel < games.length;
  const frames = onGame ? layout.framesByGame[sel]! : [];
  const content = frames.length > 0 ? frames[frameI % frames.length]! : [dim("↩  back to the main menu")];
  const title = onGame ? games[sel]!.menu.label : "Anteroom";
  const right = fixedBox(title, content, layout.innerW, layout.innerH);
  if (layout.compact) {
    const gm = onGame ? games[sel]! : null;
    const detail = gm ? dim(`${stakeTag(gm.menu.stake)} · ${gm.menu.players} — ${gm.menu.blurb}`) : "";
    right.push(padEndVisible(center(truncVisible(detail, layout.innerW + 4), layout.innerW + 4), layout.innerW + 4));
  }
  return composeColumns(left, right, layout.gap);
}

/**
 * The category submenu screen: the DETAILED game list on the LEFT and a live, looping animation of
 * the highlighted game on the RIGHT (its real board, cycled from `preview()`), inside a FIXED-size
 * box. Resolves the chosen index (games.length === Back; −1 === q/esc). On the Back row the list
 * stays exactly where it is (two-column preserved) so nothing snaps to centre; the panel shows a
 * gentle hint. Falls back to a single-column list when the canvas is too narrow (or off a TTY).
 */
function selectCategoryWithPreview(term: Terminal, section: Category, games: MenuGame[], initial: number): Promise<number> {
  return new Promise((resolve) => {
    const count = games.length + 1; // + the Back row
    let sel = initial >= 0 && initial < count ? initial : 0;
    let frameI = 0;
    let layout = buildCategoryLayout(term, games);
    const footer = "↑/↓ move · enter select · q back";
    const draw = (): void => {
      screen(term, section, composeCategoryScreen(layout, games, sel, frameI), footer);
    };
    draw();
    // The cycle timer runs at the HIGHLIGHTED game's cadence (a real preview animation like the
    // roulette spin ticks fast; view-snapshot previews at the relaxed default), so it's re-armed
    // whenever the selection or the layout changes.
    let timer: ReturnType<typeof setInterval> | undefined;
    const armTimer = (): void => {
      if (timer) clearInterval(timer);
      const ms = layout.twoCol ? (layout.msByGame[sel] ?? PREVIEW_FRAME_MS) : PREVIEW_FRAME_MS;
      timer = term.tty ? setInterval(() => { frameI++; draw(); }, ms) : undefined;
    };
    armTimer();
    let offResize: () => void = () => {};
    const finish = (n: number): void => {
      if (timer) clearInterval(timer);
      off();
      offResize();
      resolve(n);
    };
    const off = term.onKey((k) => {
      if (k.name === "up") { sel = (sel - 1 + count) % count; frameI = 0; armTimer(); draw(); }
      else if (k.name === "down") { sel = (sel + 1) % count; frameI = 0; armTimer(); draw(); }
      else if (k.name === "return") finish(sel);
      else if (k.char === "q" || k.name === "escape") finish(-1);
      else if (/^[1-9]$/.test(k.char)) { const n = Number(k.char) - 1; if (n < count) finish(n); }
    });
    offResize = term.onResize(() => {
      layout = buildCategoryLayout(term, games);
      armTimer();
      draw();
    });
  });
}

/** Client mirror of the server's minimum staked bet — the server clamps too. */
const MIN_STAKE = 5;

/**
 * The amount editor's body lines: the typed amount, the minimum above it, and the input hints
 * DIRECTLY BELOW it. The hints used to ride the canvas's reserved note row, which is pinned to the
 * bottom of the screen — so the instructions for the number you were typing sat a dozen blank rows
 * away from the number itself. Every line fits the 58-col floor. PURE (testable).
 */
export function amountPromptLines(buf: string): string[] {
  return [
    dim(`any amount · minimum ${MIN_STAKE} chips`),
    "",
    accent(bold(`${buf || "0"} chips`)),
    "",
    dim("type a number · [+/-] ±25"),
    dim("[space] or [enter] confirm · [esc] cancel"),
  ];
}

/**
 * A free-form numeric amount editor for a staked game's stake / buy-in: type any
 * number, ±25 with +/-, a minimum enforced. Resolves the chosen amount (≥ MIN_STAKE),
 * or −1 on cancel (esc) so the caller can back out.
 */
function promptAmount(term: Terminal, title: string, def: number): Promise<number> {
  return new Promise((resolve) => {
    let buf = String(def);
    const num = (): number => Math.max(0, Math.floor(Number(buf || "0")) || 0);
    const draw = (): void => {
      // The hints live in the body (amountPromptLines), not the note row — see its docblock.
      screen(term, title, amountPromptLines(buf));
    };
    draw();
    const off = term.onKey((k) => {
      // Space confirms as well as enter: this prompt sits between picking a table and being
      // matched into it, and every OTHER "lock it in" moment in a staked game is [space] (the
      // re-ante window, craps/roulette's lock-in). Enter stays for anyone who reaches for it.
      if (k.name === "return" || k.name === "space" || k.char === " ") {
        off();
        resolve(Math.max(MIN_STAKE, num()));
      } else if (k.name === "escape") {
        off();
        resolve(-1);
      } else if (/^[0-9]$/.test(k.char) && buf.length < 6) {
        buf = (buf === "0" ? "" : buf) + k.char;
        draw();
      } else if (k.name === "backspace") {
        buf = buf.slice(0, -1);
        draw();
      } else if (k.char === "+" || k.char === "=") {
        buf = String(num() + 25);
        draw();
      } else if (k.char === "-" || k.char === "_") {
        buf = String(Math.max(MIN_STAKE, num() - 25));
        draw();
      }
    });
  });
}

/** Render the sectioned menu and resolve the chosen ROW index (−1 = quit); skips headers/rules.
 *  `initial` restores the cursor to a previously-selected row (return where you were). */
function selectMenuRows(term: Terminal, rows: MenuRow[], subtitle?: string, initial?: number): Promise<number> {
  return new Promise((resolve) => {
    const selectableInit = selectableIndices(rows);
    let sel = initial != null && selectableInit.includes(initial) ? initial : (selectableInit[0] ?? 0);
    const draw = (): void => {
      screen(term, "Anteroom", renderMenuRows(rows, sel, subtitle), "↑/↓ move · enter select · q quit");
    };
    draw();
    const selectable = selectableIndices(rows);
    const off = term.onKey((k) => {
      if (k.name === "up") {
        sel = nextSelectable(rows, sel, -1);
        draw();
      } else if (k.name === "down") {
        sel = nextSelectable(rows, sel, 1);
        draw();
      } else if (k.name === "return") {
        off();
        resolve(sel);
      } else if (k.char === "q") {
        off();
        resolve(-1);
      } else if (/^[1-9]$/.test(k.char)) {
        const n = Number(k.char) - 1; // jump to the Nth selectable row
        if (n < selectable.length) {
          off();
          resolve(selectable[n]!);
        }
      }
    });
  });
}

export async function runMenu(
  term: Terminal,
  who: string,
  recent: string[] = [],
  initial?: number,
): Promise<MenuAction> {
  const games = listGameUIs();
  const rows = buildMenuRows(games, recent);
  const choice = await selectMenuRows(term, rows, who, initial);
  if (choice < 0) return { type: "quit" };
  const row = rows[choice]!;
  // On every back-out we re-enter the home menu with the cursor restored to `choice`.
  if (row.kind === "game") {
    // A Recent shortcut: straight to the stake prompt + play (backing out returns home).
    const action = await stakeThenPlay(term, row);
    return action ?? runMenu(term, who, recent, choice);
  }
  if (row.kind === "submenu") {
    // Drill into the Casual / Stakes game list; backing out returns home.
    const action = await runCategory(term, row.section, games);
    return action ?? runMenu(term, who, recent, choice);
  }
  if (row.kind === "action") {
    if (row.action === "joinRoom") {
      const code = await promptRoomCode(term);
      if (!code) return runMenu(term, who, recent, choice); // cancelled the code entry
      return { type: "joinRoom", code };
    }
    return { type: row.action };
  }
  return runMenu(term, who, recent, choice); // headers/rules aren't selectable — defensive
}

/** Run a game's stake prompt (a wager ante, a craps buy-in, or none for Casual/bankroll — a
 *  bankroll game stakes from the live balance in-session, so the menu never asks) and resolve a
 *  `play` action — or null if the player backed out of the prompt. Shared by the Recent shortcuts
 *  and the category submenu so both reach a game the same way. */
async function stakeThenPlay(
  term: Terminal,
  g: { id: string; title: string; stake: GameUI["menu"]["stake"]; defaultStake?: number; find: boolean },
): Promise<MenuAction | null> {
  let ante = 0;
  if (g.stake === "wager") ante = await selectStake(term, g.title, g.defaultStake);
  else if (g.stake === "buyin") ante = await selectBuyIn(term, g.title, g.defaultStake);
  if (ante < 0) return null;
  return { type: "play", game: g.id, ante, find: g.find };
}

/** The Casual / Stakes submenu: that category's games (+ Back). A pick flows through the stake
 *  prompt to a `play` action; q/esc/Back returns null (caller re-shows the home menu). Backing out
 *  of a game's stake prompt loops back to this list, not all the way home. */
async function runCategory(term: Terminal, section: Category, games: MenuGame[]): Promise<MenuAction | null> {
  const inSection = categoryGames(games, section);
  let sel = 0; // remember the row so backing out of a game's stake prompt returns to it
  for (;;) {
    const i = await selectCategoryWithPreview(term, section, inSection, sel);
    if (i < 0 || i >= inSection.length) return null; // q/esc or the "Back" row
    sel = i;
    const g = inSection[i]!;
    const action = await stakeThenPlay(term, {
      id: g.id,
      title: g.title,
      stake: g.menu.stake,
      defaultStake: g.menu.defaultStake,
      find: g.menu.find,
    });
    if (action) return action;
  }
}

/** Room codes are lowercase, no ambiguous chars (matches the server alphabet); ≤ a short cap. */
const ROOM_CODE_RE = /^[a-z0-9]$/;
const MAX_ROOM_CODE = 12;

/** A tiny one-line editor to enter a room code. Resolves the trimmed code, or null on cancel. */
export function promptRoomCode(term: Terminal): Promise<string | null> {
  return new Promise((resolve) => {
    let code = "";
    const draw = (): void => {
      screen(
        term,
        "Join Room",
        [dim("enter the room code a friend shared:"), "", `  ${accent(bold(code || "_"))}`],
        "type code · enter to join · esc to cancel",
      );
    };
    draw();
    const off = term.onKey((k) => {
      if (k.name === "return") {
        off();
        resolve(code.trim() || null);
      } else if (k.name === "escape") {
        off();
        resolve(null);
      } else if (k.name === "backspace") {
        code = code.slice(0, -1);
        draw();
      } else if (ROOM_CODE_RE.test(k.char) && code.length < MAX_ROOM_CODE) {
        code += k.char; // `term` already lowercases char
        draw();
      }
    });
  });
}

async function selectStake(term: Terminal, game: string, def = 50): Promise<number> {
  return promptAmount(term, `${game} — choose your stake`, def);
}

/** The buy-in is the table stack you bet from (and what you cash out against). */
async function selectBuyIn(term: Terminal, game: string, def = 100): Promise<number> {
  return promptAmount(term, `${game} — choose your buy-in`, def);
}

/** Flip the leaderboard ranking between chips and W/L. */
export function nextLeaderboardSort(sort: LeaderboardSort): LeaderboardSort {
  return sort === "chips" ? "wl" : "chips";
}

/** True for the keys that toggle the sort (←/→ to move between the columns, `s` for sort, Tab).
 *  Every other key exits the screen — preserving the historical "any key to return". */
export function isSortToggleKey(k: Key): boolean {
  return k.name === "left" || k.name === "right" || k.name === "tab" || k.char === "s";
}

/** The footer hint: names the OTHER sort as the toggle target (no em-dash, per the copy rule). */
export function leaderboardFooter(sort: LeaderboardSort): string {
  const other = sort === "chips" ? "W/L" : "chips";
  return `←/→ sort by ${other} · any other key to return`;
}

/** Fetch + show the leaderboard; ←/→ (or s/Tab) toggles chips ↔ W/L, any other key returns. */
export async function runLeaderboard(term: Terminal, server: string, selfId?: string): Promise<void> {
  let sort: LeaderboardSort = "chips";
  for (;;) {
    screen(term, "Leaderboard", [dim("loading…")]);
    const rows = await fetchLeaderboard(server, sort);
    screen(term, "Leaderboard", renderLeaderboard(rows, selfId, sizeCanvas(term).CW, sort), leaderboardFooter(sort));
    const k = await term.readKey();
    if (!isSortToggleKey(k)) return;
    sort = nextLeaderboardSort(sort);
  }
}

/** Account screen body (pure) — split out so the identity display is unit-testable. */
export function accountLines(info: { signedIn: boolean; name: string; login?: string }): string[] {
  return info.signedIn
    ? [
        // The GitHub display name/login are untrusted free text — strip control bytes before display.
        `welcome back, ${accent(sanitizeText(info.name))}${info.login ? dim(` (@${sanitizeText(info.login)})`) : ""}`,
        "",
        dim('set a display name with --username "<name>"'),
      ]
    : [
        "playing as a guest",
        "",
        dim("sign in with GitHub by launching with --login"),
        dim("(needs ANTEROOM_GITHUB_CLIENT_ID / --client-id)"),
      ];
}

/** Account screen. Returns "signout" when a signed-in user presses `s`, else "back". */
export async function runAccount(
  term: Terminal,
  info: { signedIn: boolean; name: string; login?: string },
): Promise<"signout" | "back"> {
  const footer = info.signedIn ? "[s] sign out · any other key to return" : "any key to return";
  screen(term, "Account", accountLines(info), footer);
  const key = await term.readKey();
  const choseSignOut = key.char === "s" || key.name === "s";
  return info.signedIn && choseSignOut ? "signout" : "back";
}
