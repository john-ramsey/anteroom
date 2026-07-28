/**
 * Slots — a self-contained client `GameUI` module for the SOLO, vs-the-house bankroll machine.
 *
 * The board is the "cabinet" concept: a lit marquee, a heavy-bordered three-reel window with a pull
 * lever, and a digital CREDITS / BET / WIN readout — it reads unmistakably as a slot machine. You
 * set a line bet ([+]/[-]), [space] to spin, and [c] to cash out; each spin debits the bet and the
 * server's CSPRNG draws the reels — the client only renders. The spin animation rolls
 * each reel into place left→right with a near-miss linger on the last reel, then a rainbow win pulse.
 *
 * Like roulette's WHEEL, the strip + glyphs here are DISPLAY-ONLY (used for the spinning reels'
 * neighbours + the paytable hint). The PAYLINE itself comes from the server view (`view.line`), and
 * every payout is the server's — so this cosmetic copy can never affect money.
 */
import { accent, accent2, animateFrames, bold, center, dim, fmtChips, neg, pos, rainbow, truncVisible, warn, type Lifetime } from "../../ui.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, KeyResult } from "./types.ts";

/** Slot symbol keys (mirror the server's symbols). */
type SlotSymbol = "seven" | "star" | "gem" | "club" | "heart" | "coin" | "bar";

interface SlotWin {
  symbol: SlotSymbol;
  kind: "triple" | "pair";
  multiple: number;
  amount: number;
}

/** The opaque server view, narrowed to Slots' shape. */
export interface SlotsView {
  you: string;
  buyIn: number;
  stack: number;
  bet: number;
  minBet: number;
  maxBet: number;
  stops: [number, number, number] | null;
  line: SlotSymbol[] | null;
  win: SlotWin | null;
  spins: number;
  bestWin: number;
  handOver: boolean;
  busted: boolean;
  net: number;
}

/** Glyph + colour per symbol (display only — single-cell BMP glyphs so reels never misalign). */
const SYM: Record<SlotSymbol, { glyph: string; tint: (s: string) => string }> = {
  seven: { glyph: "7", tint: (s) => neg(bold(s)) },
  star: { glyph: "★", tint: warn },
  gem: { glyph: "◆", tint: accent2 },
  club: { glyph: "♣", tint: pos },
  heart: { glyph: "♥", tint: neg },
  coin: { glyph: "●", tint: accent },
  bar: { glyph: "▦", tint: (s) => bold(s) },
};

/** The cosmetic display strip (same multiset as the server; order is purely the scroll's look). */
const STRIP: SlotSymbol[] = [
  "bar", "coin", "heart", "club", "gem", "bar", "coin", "star",
  "heart", "bar", "coin", "club", "heart", "bar", "coin", "gem",
  "heart", "bar", "coin", "seven", "club", "bar", "coin", "heart",
  "star", "bar", "coin", "gem", "club", "bar", "coin", "bar",
];
const wrap = (i: number): number => ((i % STRIP.length) + STRIP.length) % STRIP.length;
const symAt = (stop: number): SlotSymbol => STRIP[wrap(stop)]!;

/** Top-line paytable hint (display only) — matches the server's paytable. */
const PAY_HINT = "7×400  ★×120  ◆×66  ♣×34  ♥×20  ●×10  ▦×8";
const BET_STEP = 5;

interface Reel {
  up: SlotSymbol;
  mid: SlotSymbol;
  down: SlotSymbol;
  locked: boolean;
}
interface Board {
  reels: [Reel, Reel, Reel];
  credits: number;
  bet: number;
  win: SlotWin | null;
  /** true once a spin has resolved with no win (drives the "no line" caption). */
  lostSpin: boolean;
  /** 0 = normal, 1 = bright (celebrate strobe). */
  flash: number;
}

const reelAt = (stop: number, locked: boolean): Reel => ({
  up: symAt(stop - 1),
  mid: symAt(stop),
  down: symAt(stop + 1),
  locked,
});

const W = 39; // cabinet interior width (between the ┃ ┃)
const RC = 5; // reel cell width
const cell = (inner: string, w: number): string => center(inner, w);

/** The payline glyph: still spinning → dim (motion blur); locked + winning → bright/strobe;
 *  locked → its own colour. */
function lineGlyph(sym: SlotSymbol, locked: boolean, won: boolean, flash: number): string {
  const g = SYM[sym].glyph;
  if (!locked) return dim(g);
  if (won) return flash ? rainbow(g) : pos(bold(g));
  return SYM[sym].tint(g);
}

function readoutRow(b: Board, w = W): string {
  const lastWin = b.win ? warn(bold(fmtChips(b.win.amount))) : dim("0");
  const s = `${dim("CREDITS")} ${bold(fmtChips(b.credits))}   ${dim("BET")} ${bold(String(b.bet))}   ${dim("WIN")} ${lastWin}`;
  return truncVisible(s, w); // never let a big balance push the cabinet border out
}

function captionRow(b: Board): string {
  if (b.win) {
    const g = SYM[b.win.symbol].glyph;
    if (b.win.kind === "triple") return `${rainbow(`${g}${g}${g}`)}  ${pos(bold(`PAYS ${fmtChips(b.win.amount)}`))}`;
    return `${pos(bold(`${g}${g} pair`))}  ${pos(bold(`+${fmtChips(b.win.amount)}`))}`;
  }
  return b.lostSpin ? dim("no line — spin again") : dim("spin to play · vs. the house");
}

/** The cabinet board as CONTENT LINES (no outer frame — the shell wraps it in the shared canvas).
 *  Every interior line is built to exactly W cols then wrapped in `┃ … ┃`, so the heavy border
 *  stays rectangular no matter the content. PURE. */
function cabinetLines(b: Board, maxCols?: number): string[] {
  // Default to the fixed 39-col cabinet; with a width budget (GameCtx.boardCols) shrink the cabinet
  // to fit the canvas (border is w+2) rather than shearing the heavy ┃ frame — floored at the reel
  // window + lever chrome so the interior never clips.
  const w = maxCols === undefined ? W : Math.max(27, Math.min(W, maxCols - 2));
  const row = (interior: string): string => dim("┃") + center(interior, w) + dim("┃");
  const bar = (l: string, r: string): string => dim(l + "━".repeat(w) + r);
  const won = !!b.win;
  const lg = (r: Reel): string => cell(lineGlyph(r.mid, r.locked, won, b.flash), RC);
  const dg = (g: string): string => cell(dim(g), RC);
  const window = (cells: string): string => "│" + cells + "│";
  const sub = (left: string, mid: string, right: string): string => left + mid + right;

  const marquee = b.flash ? accent(bold("A N T E R O O M")) : accent2(bold("A N T E R O O M"));
  const reelTop = "┌" + "─────┬".repeat(2) + "─────┐";
  const reelBot = "└" + "─────┴".repeat(2) + "─────┘";
  const upCells = b.reels.map((r) => dg(SYM[r.up].glyph)).join("│");
  const midCells = b.reels.map(lg).join("│");
  const downCells = b.reels.map((r) => dg(SYM[r.down].glyph)).join("│");

  const interior = [
    marquee,
    dim("·  S L O T S  ·"),
    "__BAR__",
    sub("   ", reelTop, "   "),
    sub("   ", window(upCells), "  ╓"),
    sub(accent(" ▶ "), window(midCells), accent(" ◀ ")),
    sub("   ", window(downCells), "  ║"),
    sub("   ", reelBot, "  ╜"),
    "__BAR__",
    readoutRow(b, w),
    captionRow(b),
  ];
  return [bar("┏", "┓"), ...interior.map((l) => (l === "__BAR__" ? bar("┣", "┫") : row(l))), bar("┗", "┛")];
}

/** A resting board straight from the server view (pre-spin → a neutral idle arrangement). */
function boardFromView(view: SlotsView): Board {
  const stops = view.stops ?? [2, 9, 5]; // idle resting offsets when no spin has happened yet
  const reels = stops.map((s, k) => {
    const r = reelAt(s, true);
    // Pin the payline to the AUTHORITATIVE server result (`view.line`); the local strip only
    // colours the cosmetic up/down neighbours. Mirrors roulette rendering its `lastNumber`
    // rather than re-deriving the pocket — so a future strip re-tune can't desync the payline.
    if (view.line) r.mid = view.line[k]!;
    return r;
  }) as [Reel, Reel, Reel];
  return {
    reels,
    credits: view.stack,
    bet: view.bet,
    win: view.win,
    lostSpin: view.line !== null && view.win === null,
    flash: 0,
  };
}

// --- spin choreography ------------------------------------------------------
const STOP_AT_BASE: [number, number, number] = [7, 11, 15];
const NEAR_MISS_LINGER = 7; // extra frames on reel 3 when reels 1 & 2 already match (tension)

/** Reel states at frame `f`: each reel rolls UP into its target (1 stop/frame) then locks. */
function reelsAtFrame(f: number, target: [number, number, number], stopAt: [number, number, number]): [Reel, Reel, Reel] {
  return [0, 1, 2].map((k) =>
    f >= stopAt[k]! ? reelAt(target[k]!, true) : reelAt(target[k]! - (stopAt[k]! - f), false),
  ) as [Reel, Reel, Reel];
}

export const slotsUI: GameUI<SlotsView> = {
  id: "slots",
  title: "Slots",
  // "bankroll": no stake prompt — the session stakes min(balance, MAX_ANTE) automatically and
  // silently re-buys from the live balance on a bust, so play feels like drawing straight down
  // from the wallet. The per-spin bet is the only number the player ever touches.
  menu: { label: "Slots", stake: "bankroll", find: false, blurb: "Pull the lever, chase the 7s.", players: "Solo" },
  completion: "continuous",

  // A bust re-buys and keeps spinning; a voluntary cash-out means "I'm done" — bank the chips
  // and leave with a summary (the idle timeout is also a cash-out, so an AFK player exits too).
  stayAfterSettle(view) {
    return view.busted;
  },

  // Menu preview: the idle cabinet, then three 7s land (rendered through the real `render`, cycled
  // by the submenu).
  preview() {
    const base: SlotsView = {
      you: "you", buyIn: 200, stack: 200, bet: 25, minBet: 5, maxBet: 100,
      stops: null, line: null, win: null, spins: 0, bestWin: 0, handOver: false, busted: false, net: 0,
    };
    const mk = (stops: [number, number, number], line: SlotsView["line"], stack: number, spins: number, net: number, win: SlotsView["win"] = null): SlotsView => ({
      ...base, stops, line, win, stack, spins, bestWin: win ? win.amount : 0, net,
    });
    return [
      base,
      mk([0, 1, 2], ["bar", "coin", "heart"], 175, 1, -25),
      mk([7, 4, 6], ["star", "gem", "coin"], 150, 2, -50),
      mk([19, 19, 1], ["seven", "seven", "coin"], 125, 3, -75),
      mk([19, 19, 19], ["seven", "seven", "seven"], 10_125, 4, 9_925, { symbol: "seven", kind: "triple", multiple: 400, amount: 10_000 }),
    ];
  },

  boardTitle(view, ctx) {
    // Slots is a SOLO 1-seat cabinet — a room code is a
    // shareable/multiplayer concept that doesn't apply here (no one else can join), so the title
    // carries NO room, unlike the multiplayer tables (blackjack/craps/roulette).
    // Mid-session, show the wallet BEHIND the machine (balance − the escrowed slice) so
    // CREDITS + wallet read as one continuous bankroll (the draw-down feel). Once the
    // session settles (or before the balance is known) that split is stale — show the buy-in.
    if (!view.handOver && ctx.balance != null) {
      return `Slots  ·  wallet ${fmtChips(Math.max(0, ctx.balance - view.buyIn))}`;
    }
    return `Slots  ·  buy-in ${fmtChips(view.buyIn)}`;
  },

  render(view, ctx) {
    return cabinetLines(boardFromView(view), ctx.boardCols);
  },

  controls() {
    return [
      accent("▶ [space] spin   ·   [+ / -] bet   ·   [c] cash out"),
      dim(`${PAY_HINT}  ·  pairs pay`),
    ];
  },

  isMyTurn(view, playing) {
    return playing && !view.handOver;
  },

  status(view) {
    if (view.handOver) return null; // the settlement tally + next-deal banner take over
    if (view.spins === 0) return null; // pre-first-spin: the cabinet caption says "spin to play"
    const net =
      view.net > 0 ? pos(bold(`+${fmtChips(view.net)}`)) : view.net < 0 ? neg(bold(`−${fmtChips(-view.net)}`)) : dim("even");
    return `${dim(`${view.spins} spins`)}  ·  ${net} ${dim("net")}  ·  ${dim(`best ${fmtChips(view.bestWin)}`)}`;
  },

  onKey(k: Key, view): KeyResult {
    if (k.char === "+" || k.char === "=") {
      const amount = Math.min(view.maxBet, view.bet + BET_STEP);
      return amount === view.bet ? { handled: true } : { move: { kind: "bet", amount }, keepTurn: true };
    }
    if (k.char === "-" || k.char === "_") {
      const amount = Math.max(view.minBet, view.bet - BET_STEP);
      return amount === view.bet ? { handled: true } : { move: { kind: "bet", amount }, keepTurn: true };
    }
    if (k.name === "space" || k.char === " ") {
      if (view.bet > view.stack) return { handled: true, status: warn("lower your bet — not enough credits") };
      return { move: { kind: "spin" }, keepTurn: true, status: dim("spinning…") };
    }
    if (k.char === "c") return { move: { kind: "cashout" }, status: dim("cashing out…") };
    return null;
  },

  /** The cash-out exit screen (a voluntary cash-out leaves the table via `stayAfterSettle`).
   *  [space] "play again" sits back down at a fresh bankroll session. */
  summary(view, ctx) {
    const lifetime = (ctx.ui.lifetime as Lifetime | undefined) ?? undefined;
    const net = view.net;
    const headline = view.busted
      ? neg(bold("busted — the machine kept your slice"))
      : net > 0
        ? pos(bold(`cashed out +${fmtChips(net)} chips`))
        : net < 0
          ? warn(bold(`cashed out −${fmtChips(-net)} chips`))
          : warn(bold("cashed out even"));
    const lines = [
      headline,
      "",
      `${dim("banked")} ${bold(fmtChips(view.stack))} ${dim("chips")}  ·  ${dim(`buy-in ${fmtChips(view.buyIn)}`)}`,
      `${dim(`${view.spins} spins`)}  ·  ${dim("best win")} ${bold(fmtChips(view.bestWin))}`,
    ];
    if (lifetime) {
      const parts = [`${pos(String(lifetime.wins))}${dim("–")}${neg(String(lifetime.losses))} W–L`];
      if (lifetime.rank) parts.push(`rank ${bold(`#${lifetime.rank}`)}`);
      if (lifetime.balance !== undefined) parts.push(`${bold(lifetime.balance.toLocaleString("en-US"))} chips`);
      lines.push("", `${dim("lifetime")}  ${parts.join(dim("  ·  "))}`);
    }
    lines.push("", dim("[space] sit back down · [m] menu"));
    return lines;
  },

  async onView(prev, next, ctx, paint) {
    if (next.stops === null) return; // nothing has been spun yet
    const isNewSpin = !prev || prev.spins !== next.spins;
    if (!isNewSpin) return; // a bet change / re-render is not a spin

    const target = next.stops;
    const line = next.line ?? [symAt(target[0]), symAt(target[1]), symAt(target[2])];
    const stopAt: [number, number, number] = [...STOP_AT_BASE];
    // Near-miss anticipation: reels 1 & 2 already match → linger on reel 3 (could complete the line).
    if (line[0] === line[1]) stopAt[2] += NEAR_MISS_LINGER;

    const duringSpin = prev ? prev.stack : next.stack; // show the pre-resolution balance while rolling
    const scroll: string[] = [];
    for (let f = 0; f <= stopAt[2]; f++) {
      const allLocked = f >= stopAt[2];
      const b: Board = {
        reels: reelsAtFrame(f, target, stopAt),
        credits: allLocked ? next.stack : duringSpin,
        bet: next.bet,
        win: allLocked ? next.win : null,
        lostSpin: allLocked && next.win === null,
        flash: 0,
      };
      scroll.push(cabinetLines(b, ctx.boardCols).join("\n"));
    }
    await animateFrames(scroll, 55, ctx.tty, paint); // ends on the settled board

    // Win pulse: a few rainbow strobes on the settled cabinet (REPLACE — no board bump).
    if (next.win) {
      const settled = boardFromView(next);
      const pulse: string[] = [];
      for (let i = 0; i < 8; i++) pulse.push(cabinetLines({ ...settled, flash: i % 2 }, ctx.boardCols).join("\n"));
      pulse.push(cabinetLines(settled, ctx.boardCols).join("\n"));
      await animateFrames(pulse, 110, ctx.tty, paint);
    }
  },
};
