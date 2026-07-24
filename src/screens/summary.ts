/**
 * End-of-match summary for a one-shot game — game-agnostic. Resolves the player's next
 * choice (play again / menu / quit) so the app shell can replay or return.
 *
 * The body comes from the game's `GameUI.summary(view, ctx)` (RPS's round-by-round + throw
 * mix, four-in-a-row's headline, …), framed in the shared full-screen canvas so it's the
 * same size as every other screen. The lifetime stats (W–L / rank / balance) are handed to
 * the game via `ctx.ui.lifetime`. The shell carries no per-game branching.
 */
import type { Terminal } from "../terminal.ts";
import { screen } from "./canvas.ts";
import { getGameUI } from "./games/registry.ts";
import type { Lifetime } from "../ui.ts";

export function runSummary(
  term: Terminal,
  game: string,
  view: unknown,
  nameFor: (id: string) => string,
  lifetime?: Lifetime,
): Promise<"again" | "menu" | "quit"> {
  const ui = getGameUI(game);
  return new Promise((resolve) => {
    // No summary renderer (e.g. a continuous table that never reaches here) → straight to menu.
    if (!ui.summary) {
      resolve("menu");
      return;
    }
    const ctx = {
      room: "",
      nameFor,
      myId: "",
      myTurn: false,
      ui: { lifetime } as Record<string, unknown>,
      tty: term.tty,
    };
    screen(term, ui.title, ui.summary(view, ctx));
    const off = term.onKey((k) => {
      // [space] replay · [m]/enter menu · [q] quit (other keys are ignored — stay on the summary).
      if (k.char === " " || k.name === "space") {
        off();
        resolve("again");
      } else if (k.char === "m" || k.name === "return") {
        off();
        resolve("menu");
      } else if (k.char === "q") {
        off();
        resolve("quit");
      }
    });
  });
}
