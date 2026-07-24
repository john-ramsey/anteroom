/**
 * Rock · Paper · Scissors — a self-contained client `GameUI` module.
 *
 * One-shot, two-player, winner-take-all wager (or friendly). Moved here from ui.ts /
 * session.ts: the board renderer, the slot-shuffle reveal animation, the throw-mix
 * summary, and the [r]/[p]/[s] input mapping all live in this module. The session shell
 * never branches on the game id — it resolves this through the registry.
 */
import {
  accent,
  accent2,
  bold,
  center,
  dim,
  neg,
  padEndVisible,
  playInPlace,
  pos,
  rule,
  sparkle,
  visibleLen,
  warn,
  type Lifetime,
} from "../../ui.ts";
import type { Key } from "../../terminal.ts";
import type { GameUI, KeyResult } from "./types.ts";

export interface RpsView {
  bestOf: number;
  target?: number;
  round: number;
  scores: Record<string, number>;
  history: Array<{ moves: Record<string, string>; winner: string | null }>;
  you: string;
  opponent: string | null;
  /** Seat-ordered roster (a spectator holds no seat, so `you`/`opponent` can't name the table).
   *  Optional only for older fabricated views — the wire always carries it. */
  players?: string[];
  yourMove: string | null;
  youSubmitted: boolean;
  opponentSubmitted: boolean;
}

/** The two ids the board renders, left/right. Seated: first-person (you, opponent). A spectator
 *  (not in `players`) reads seat-vs-seat — the real players, never a phantom "@spectator" row. */
function boardSides(v: RpsView): { a: string; b: string | null; seated: boolean } {
  const seated = !v.players || v.players.includes(v.you);
  if (seated) return { a: v.you, b: v.opponent, seated };
  return { a: v.players![0] ?? v.you, b: v.players![1] ?? null, seated };
}

const MOVES: Record<string, string> = { r: "rock", p: "paper", s: "scissors" };
const SYMS = ["rock", "paper", "scissors"];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A move shown as a coloured uppercase badge (no emoji). */
function moveBadge(move: string): string {
  const m = move.toLowerCase();
  const tint = m === "rock" ? accent2 : m === "paper" ? warn : accent;
  return tint(bold(move.toUpperCase()));
}

/** The score-board content LINES (no box — the shell frames it in the canvas). */
function renderRps(v: RpsView, room: string, nameFor: (id: string) => string): string[] {
  const target = v.target ?? Math.floor(v.bestOf / 2) + 1;
  const pips = (n: number): string =>
    pos("●".repeat(n)) + dim("○".repeat(Math.max(0, target - n)));
  const { a, b, seated } = boardSides(v);
  const meScore = v.scores[a] ?? 0;
  const oppScore = b ? (v.scores[b] ?? 0) : 0;

  const lines: string[] = [
    `${dim("room")} ${bold(room)}    ${dim("·")}    ${dim(`best of ${v.bestOf} · round ${v.round}`)}`,
    "",
    `${padEndVisible(accent(bold(nameFor(a))), 18)} ${bold(String(meScore))}   ${pips(meScore)}`,
    `${padEndVisible(accent2(b ? nameFor(b) : "waiting…"), 18)} ${bold(String(oppScore))}   ${b ? pips(oppScore) : ""}`,
  ];

  const last = v.history[v.history.length - 1];
  if (last && b) {
    const mine = last.moves[a];
    const theirs = last.moves[b];
    const result =
      last.winner === null
        ? warn("push")
        : seated
          ? last.winner === v.you
            ? pos("you won")
            : neg("you lost")
          : pos(`${nameFor(last.winner)} won`);
    lines.push(rule(Math.max(...lines.map(visibleLen))));
    lines.push(
      `${dim("last")}   ${mine ? moveBadge(mine) : "—"} ${dim("vs")} ${theirs ? moveBadge(theirs) : "—"}   ${dim("→")} ${result}`,
    );
  }
  return lines;
}

// Widest move word ("scissors") — every reveal badge is centred in this many columns so the
// slot-shuffle never changes line length as it flips rock(4)/paper(5)/scissors(8); otherwise the
// "vs" separator and the opponent badge would jitter sideways mid-spin.
const BADGE_W = "scissors".length;

// The spin status; also the widest status the panel ever shows. The status is centred in this many
// columns so the whole panel keeps one fixed total width — when the spin gives way to the shorter
// outcome (PUSH / YOU WIN / YOU LOSE), the canvas (which centres every line) won't snap it sideways.
const REVEAL_STATUS = "· revealing ·";
const STATUS_W = REVEAL_STATUS.length;

/** The WIDE reveal panel: the two throws strung out on one line, `you [badge] vs [badge] opp
 *  status`. The roomy, cinematic layout — used when the terminal is wide enough for it. */
function rpsPanelWide(you: string, youBadge: string, opp: string, oppBadge: string, status: string): string {
  return `   ${accent(you)}  ${center(youBadge, BADGE_W)}   ${dim("vs")}   ${center(oppBadge, BADGE_W)}  ${accent2(opp)}     ${center(status, STATUS_W)}`;
}

/** The STACKED reveal panel: the two throws face off vertically (yours on top, theirs below),
 *  the status underneath — narrow enough for a small terminal, where the wide one-liner would be
 *  truncated by the canvas. Every element is centred in a fixed-width field, so the slot-shuffle
 *  never changes the panel's width or nudges a badge sideways as it flips
 *  rock(4)/paper(5)/scissors(8); the canvas then centres the whole block. */
function rpsPanelStacked(you: string, youBadge: string, opp: string, oppBadge: string, status: string): string {
  const W = Math.max(BADGE_W, STATUS_W, visibleLen(you), visibleLen(opp));
  const row = (s: string): string => center(s, W);
  return [
    row(accent(you)),
    row(center(youBadge, BADGE_W)),
    row(dim("vs")),
    row(center(oppBadge, BADGE_W)),
    row(accent2(opp)),
    "",
    row(center(status, STATUS_W)),
  ].join("\n");
}

/**
 * Frames that reveal an RPS round like a slot machine: both sides cycle random moves,
 * then snap to the actual moves with the outcome. The shell prints the full board after.
 *
 * Responsive: the wide one-line panel when the board width (`boardCols`) permits — keeping the
 * roomy layout on a normal terminal — else the stacked vertical panel, so a narrow terminal (and
 * the marketing-site capture, which forces a narrow width to keep RPS the smallest board) gets a
 * layout that fits instead of being truncated. The choice is made ONCE (constant panel width, so
 * the badge cycle never changes it) so it can't flip mid-spin.
 */
function rpsRevealFrames(v: RpsView, nameFor: (id: string) => string, boardCols?: number): string[] {
  const last = v.history[v.history.length - 1];
  const { a, b, seated } = boardSides(v);
  if (!last || !b) return [];
  const you = nameFor(a);
  const opp = nameFor(b);
  // Measure the wide panel at its fixed maximum (scissors badges) and use it only if it fits.
  const probe = rpsPanelWide(you, moveBadge("scissors"), opp, moveBadge("scissors"), REVEAL_STATUS);
  const panel = boardCols === undefined || visibleLen(probe) <= boardCols ? rpsPanelWide : rpsPanelStacked;
  const frames: string[] = [];
  for (let k = 0; k < 12; k++) {
    frames.push(panel(you, moveBadge(SYMS[k % 3]!), opp, moveBadge(SYMS[(k + 2) % 3]!), dim(REVEAL_STATUS)));
  }
  const outcome =
    last.winner === null
      ? warn(bold("PUSH"))
      : seated
        ? last.winner === v.you
          ? pos(bold("YOU WIN"))
          : neg(bold("YOU LOSE"))
        : pos(bold(`${nameFor(last.winner).toUpperCase()} WINS`));
  const reveal = panel(
    you,
    moveBadge(last.moves[a] ?? "rock"),
    opp,
    moveBadge(last.moves[b] ?? "rock"),
    outcome,
  );
  // Hold the final reveal a beat — playInPlace sleeps between frames, so repeating the
  // same frame keeps the result up without snapping straight to the board.
  frames.push(reveal, reveal, reveal, reveal);
  return frames;
}

/** End-of-match summary LINES: outcome + round-by-round + your throw mix + lifetime. */
function renderRpsSummary(v: RpsView, nameFor: (id: string) => string, lifetime?: Lifetime): string[] {
  const me = v.scores[v.you] ?? 0;
  const opp = v.opponent ? (v.scores[v.opponent] ?? 0) : 0;
  const headline =
    me > opp ? sparkle("YOU WIN") : me < opp ? neg(bold("YOU LOSE")) : warn(bold("TIE"));
  const lines: string[] = [
    `${dim(nameFor(v.you))} ${dim("— match summary")}`,
    "",
    `${headline}    ${dim("final")} ${bold(`${me}–${opp}`)}`,
    "",
  ];

  v.history.forEach((r, i) => {
    const mine = r.moves[v.you];
    const theirs = v.opponent ? r.moves[v.opponent] : undefined;
    const res =
      r.winner === null ? warn("push") : r.winner === v.you ? pos("won") : neg("lost");
    lines.push(
      `${dim(`r${i + 1}`)}  ${mine ? moveBadge(mine) : "—"} ${dim("vs")} ${theirs ? moveBadge(theirs) : "—"}  ${dim("→")} ${res}`,
    );
  });

  const mix: Record<string, number> = { rock: 0, paper: 0, scissors: 0 };
  for (const r of v.history) {
    const m = r.moves[v.you];
    if (m && m in mix) mix[m]!++;
  }
  lines.push(
    "",
    `${dim("your throws")}  ${moveBadge("rock")} ${mix.rock}  ${moveBadge("paper")} ${mix.paper}  ${moveBadge("scissors")} ${mix.scissors}`,
  );

  if (lifetime) {
    const parts = [`${pos(String(lifetime.wins))}${dim("–")}${neg(String(lifetime.losses))} W–L`];
    if (lifetime.rank) parts.push(`rank ${bold(`#${lifetime.rank}`)}`);
    if (lifetime.balance !== undefined) parts.push(`${bold(lifetime.balance.toLocaleString("en-US"))} chips`);
    lines.push("", `${dim("lifetime")}  ${parts.join(dim("  ·  "))}`);
  }

  lines.push("", dim("[space] play again · [m] menu · [q] quit"));
  return lines;
}

export const rpsUI: GameUI<RpsView> = {
  id: "rps",
  title: "Rock · Paper · Scissors",
  menu: {
    label: "Rock · Paper · Scissors",
    stake: "none",
    find: true,
    blurb: "Best of three, one quick throw.",
    players: "2P",
  },
  completion: "summary",

  render(view, ctx) {
    return renderRps(view, ctx.room, ctx.nameFor);
  },

  // A looping menu preview of ONE coherent best-of-three: the round number climbs, the score
  // accumulates, and each frame shows that round's resolved throw — you take it 2–1. Rendered
  // through the real `render`, so it can't drift from the live board.
  preview() {
    const base = {
      bestOf: 3,
      target: 2,
      you: "you",
      opponent: "Rival",
      yourMove: null,
      youSubmitted: false,
      opponentSubmitted: false,
    };
    const round = (n: number, mine: string, theirs: string, winner: string | null, ms: number, os: number): RpsView => ({
      ...base,
      round: n,
      scores: { you: ms, Rival: os },
      history: [{ moves: { you: mine, Rival: theirs }, winner }],
    });
    return [
      round(1, "rock", "scissors", "you", 1, 0),   // you take round 1
      round(2, "rock", "paper", "Rival", 1, 1),    // Rival levels it
      round(3, "scissors", "paper", "you", 2, 1),  // you close out the match 2–1
    ];
  },

  controls() {
    return [accent("▶ [r]ock  [p]aper  [s]cissors")];
  },

  onKey(key: Key): KeyResult {
    const move = MOVES[key.char];
    return move ? { move, status: dim(`you played ${move.toUpperCase()} — waiting…`) } : null;
  },

  isMyTurn(view, playing) {
    return playing && !view.youSubmitted;
  },

  status(view) {
    // Once you've thrown but your opponent hasn't, surface the wait.
    const waiting = view.youSubmitted && view.opponent !== null && !view.opponentSubmitted;
    return waiting ? dim("waiting for opponent…") : null;
  },

  async onView(prev, next, ctx, paint) {
    // A freshly-resolved round gets the slot-shuffle reveal first.
    if (next.history.length <= (prev?.history.length ?? 0) || !next.opponent) return;
    const frames = rpsRevealFrames(next, ctx.nameFor, ctx.boardCols);
    if (frames.length === 0) return;
    if (ctx.tty) {
      for (let i = 0; i < frames.length; i++) {
        paint(frames[i]!);
        if (i < frames.length - 1) await sleep(85);
      }
    } else {
      await playInPlace(frames, 85);
    }
  },

  summary(view, ctx) {
    const lifetime = (ctx.ui.lifetime as Lifetime | undefined) ?? undefined;
    return renderRpsSummary(view, ctx.nameFor, lifetime);
  },
};
