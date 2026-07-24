/**
 * The client-side game registry — the single place that knows the set of games.
 *
 * Mirrors the server's game registry: the menu iterates `listGameUIs()` (data-driven,
 * no hand-numbered switch) and the session shell resolves a board/input via `getGameUI(id)`
 * (no `if (game === ...)` branching). A new game is one module here + one entry in this list.
 */
import { blackjackUI } from "./blackjack.ts";
import { crapsUI } from "./craps.ts";
import { fourInARowUI } from "./fourInARow.ts";
import { reversiUI } from "./reversi.ts";
import { rouletteUI } from "./roulette.ts";
import { rpsUI } from "./rps.ts";
import { slotsUI } from "./slots.ts";
import type { GameUI } from "./types.ts";

/** Registered games, in menu order (Casual ones first, then Stakes — the menu sections by stake). */
const GAMES: GameUI[] = [
  rpsUI as GameUI,
  fourInARowUI as GameUI,
  reversiUI as GameUI,
  blackjackUI as GameUI,
  crapsUI as GameUI,
  rouletteUI as GameUI,
  slotsUI as GameUI,
];

const BY_ID = new Map<string, GameUI>(GAMES.map((g) => [g.id, g]));

/** Every registered game UI, in menu order. */
export function listGameUIs(): GameUI[] {
  return GAMES;
}

/** Resolve a game UI by id. Throws on an unknown id (a programming error — the server
 *  only ever names a registered game). */
export function getGameUI(id: string): GameUI {
  const ui = BY_ID.get(id);
  if (!ui) throw new Error(`unknown game: ${id}`);
  return ui;
}
