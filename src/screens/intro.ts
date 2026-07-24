/**
 * The app-open intro: a first-person "sit down at the table" sequence. The neon ANTEROOM sign
 * flickers on, a felt table draws in, the dealer shuffles, your buy-in counts up at your seat,
 * and a random line of table talk lingers just below your chips.
 *
 * Plays once on a normal startup. It is SKIPPABLE — any key cuts to the menu — and is skipped
 * entirely off a TTY (pipes/CI) and when the client is launched straight into a game via flags.
 *
 * Self-contained animation on purpose, but it shares the full-screen, aspect-locked "canvas"
 * (`sizeCanvas` + `frame` in screens/canvas.ts) with every other screen, so the intro is
 * exactly the same size as the menu/game/etc. The UI demo (`npm run demo`, scripts/ui-demo.ts)
 * imports and plays this `runIntro` directly, so it can't drift. It draws from the shared
 * semantic palette in ui.ts, so the user's theme flows through.
 */
import { accent, accent2, bold, center, dim, neg, warn } from "../ui.ts";
import { frame, sizeCanvas } from "./canvas.ts";
import type { Terminal } from "../terminal.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const FELT_W = 48;
/** A single-colour chip stack. */
const CHIP = (): string => accent("●●●");
/** The felt table: dealer far (top), your rail near (bottom). Pass `chips` to show YOUR chip
 *  count at the near rail (where you sit); omit it for an empty felt. */
function feltLines(chips: number | null = null): string[] {
  const W = FELT_W;
  const top = 20;
  const bottom = 34;
  const H = 6;
  const L = [center(accent2(bold("D E A L E R")), W), center(dim(" " + "_".repeat(top) + " "), W)];
  for (let r = 0; r < H; r++) {
    const inner = Math.round(top + ((bottom - top) * (r + 1)) / (H + 1));
    let c = "";
    if (r === 1) c = accent(bold("A N T E R O O M"));
    else if (r === 2) c = neg("♥") + "  " + bold("♠") + "   " + neg("♦") + "  " + bold("♣");
    else if (r === 4) c = dim("· place your bets ·");
    L.push(center(dim("╱") + (c ? center(c, inner) : " ".repeat(inner)) + dim("╲"), W));
  }
  L.push(center(dim("╱" + "‗".repeat(bottom) + "╲"), W));
  if (chips !== null) {
    // your chip count sits where you sit; a fixed-width field keeps the flanking chips steady.
    const count = center(`${bold(chips.toLocaleString("en-US"))} ${dim("chips")}`, 13);
    L.push("", center(`${CHIP()}    ${CHIP()}   ${count}   ${CHIP()}    ${CHIP()}`, W));
  }
  return L;
}

/** Ambient "table talk" — one line is picked at random to linger beneath your chips. */
const TABLE_TALK = [
  "the dealer nods — good luck",
  "your seat was waiting for you",
  "the felt's still warm from the last hand",
  "no rush — the table's yours",
  "fortune favors the patient",
  "a fresh deck, a fresh start",
  "house rules: have fun",
  "someone just hit a royal two tables over",
  "the cocktails are on the house tonight",
  "play the long game",
  "the dice remember nothing",
  "every hand's a new story",
  "keep your chips close",
  "the dealer cracks a smile",
  "win or lose, you're among friends",
  "the pit boss tips their hat",
  "good seats never stay empty long",
  "the cards don't care who's watching",
  "double or nothing is always on the menu",
  "may the next one be yours",
];
function pickTalk(): string {
  return TABLE_TALK[Math.floor(Math.random() * TABLE_TALK.length)] ?? TABLE_TALK[0]!;
}

function neonSign(mask: boolean[]): string[] {
  const word = [..."ANTEROOM"].map((ch, i) => (mask[i] ? accent(bold(ch)) : dim(ch))).join(" ");
  const star = (on: boolean): string => (on ? warn("✦") : dim("✦"));
  return ["", `${star(mask[0] ?? false)}   ${word}   ${star(mask[7] ?? false)}`, "", dim("open all night  ·  play while you wait")];
}

/**
 * Play the sit-down intro on `term`. Resolves when the sequence finishes or the user presses a
 * key to skip. No-op off a TTY. Restores nothing itself — the caller owns the terminal.
 */
export async function runIntro(term: Terminal): Promise<void> {
  if (!term.tty) return;
  const g = sizeCanvas(term);
  let skip = false;
  const off = term.onKey(() => {
    skip = true;
  });
  const play = async (frames: string[], delay: number): Promise<void> => {
    for (let i = 0; i < frames.length && !skip; i++) {
      term.paint(frames[i] ?? "");
      if (i < frames.length - 1) await sleep(delay);
    }
  };
  const beat = async (ms: number): Promise<void> => {
    if (!skip) await sleep(ms);
  };
  try {
    // arrive: the marquee flickers on
    const neon: string[] = [];
    for (let f = 0; f < 5; f++) {
      const mask = Array.from({ length: 8 }, () => Math.random() > (f < 3 ? 0.45 : 0.1));
      neon.push(frame(g, "Anteroom", neonSign(mask), "arriving…"));
    }
    neon.push(frame(g, "Anteroom", neonSign(Array.from({ length: 8 }, () => true)), "welcome in — find a table"));
    await play(neon, 150);
    await beat(600);
    if (skip) return;
    // walk up to a quiet table
    await play([frame(g, "Anteroom", ["", dim("a quiet table in the back of the room…")], "")], 1);
    await beat(600);
    if (skip) return;
    // the felt draws in (dealer side first)
    const full = feltLines();
    const reveal: string[] = [];
    for (let k = 2; k <= full.length; k++) reveal.push(frame(g, "Anteroom", full.slice(0, k), "pulling up a chair…"));
    await play(reveal, 120);
    await beat(350);
    if (skip) return;
    // the dealer shuffles — a quick riffle flourish over the empty felt
    const riffles = ["▌  ▌  ▌      ▐  ▐  ▐", "  ▌ ▌ ▌  ▐ ▐ ▐  ", "▌▐ ▌▐ ▌▐ ▌▐ ▌▐", "▐ ▮ ▮ ▮ ▮ ▮ ▮ ▌"];
    await play(riffles.map((r) => frame(g, "Anteroom", [...full, "", center(accent(r), FELT_W)], "the dealer shuffles up…")), 140);
    await beat(350);
    if (skip) return;
    // your buy-in counts up at your seat, with a random table-talk line directly below it the
    // whole time (a two-row block). Fixed step count → same timing for any buy-in; the line
    // appears the moment the chips start counting and lingers through the count-up + the hold.
    const buyIn = 5000;
    const STEPS = 10;
    const line = pickTalk();
    const talkRow = (lit: boolean): string => center(lit ? accent(bold(line)) : dim(line), FELT_W);
    const countUp: string[] = [];
    for (let s = 0; s <= STEPS; s++) {
      const n = s === STEPS ? buyIn : Math.round((buyIn * s) / STEPS);
      countUp.push(frame(g, "Anteroom", [...feltLines(n), talkRow(s > 0)], "press any key to begin"));
    }
    await play(countUp, 90);
    await beat(1300);
  } finally {
    off();
  }
}
