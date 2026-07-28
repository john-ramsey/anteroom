/**
 * Doorman greetings for the lobby HUD — a maître d' who recognizes you when you walk back in.
 * Casino-floor voice, same spirit as the dealer's table talk (see dealer.ts) and the menu's
 * ambient lines. Some lines greet you by name, some stand on their own; `pickDoorman` chooses
 * one and fills in the name when the line calls for it.
 *
 * House copy style: no em-dashes, and never a reference to who (or what) you're playing.
 */

/** Lines that address you by name — `{name}` is replaced with your display name. */
const BY_NAME = [
  "welcome back, {name}",
  "good to see you again, {name}",
  "back for another round, {name}",
  "the usual table, {name}?",
  "{name}, the house missed you",
  "evening, {name}, your seat's waiting",
  "ah, {name}, welcome in",
  "{name}, the felt's been quiet without you",
  "rolling out the green for you, {name}",
  "{name}, chips stacked and waiting",
  "there you are, {name}, pull up a chair",
  "back at it, {name}?",
  "{name}, lady luck's been asking about you",
  "welcome home, {name}",
];

/** Standalone lines — used when there's no name, and mixed in when there is. */
const NO_NAME = [
  "welcome back to the floor",
  "the doorman waves you through",
  "your table's ready",
  "step right in",
  "the bartender sees you walk in and starts your usual",
  "the pit boss nods you in",
  "good to have you back at the table",
  "the felt's warm and the cards are fresh",
  "come on in, the game's just getting good",
  "the house welcomes you back",
  "chips up, let's play",
  "the dealer's been waiting on you",
  "the table's yours tonight",
  "the velvet rope lifts for you",
  "fresh deck, open seat",
  "the floor's alive tonight",
];

/** Every doorman greeting (name + standalone), for counts and tests. */
export const DOORMAN_GREETINGS: readonly string[] = [...BY_NAME, ...NO_NAME];

/**
 * The name the doorman uses: the FIRST word of whatever you signed in as.
 *
 * A GitHub profile name is usually a full name, and "John Ramsey, the felt's been quiet without
 * you" reads like a summons rather than a welcome — the whole point of these lines is that someone
 * here knows you. A login or handle ("john-ramsey", "@octocat") has no space to split on and comes
 * back unchanged. Whitespace-only gives back nothing, so the caller falls through to the standalone
 * lines instead of greeting a blank. PURE.
 */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * Pick a doorman greeting. With a name, any line is fair game (the name-lines get filled in with
 * your FIRST name); without one, only the standalone lines are used, so a `{name}` placeholder can
 * never leak. `rand` is injectable for deterministic tests.
 */
export function pickDoorman(name?: string, rand: () => number = Math.random): string {
  const first = name ? firstName(name) : "";
  const pool = first ? DOORMAN_GREETINGS : NO_NAME;
  const line = pool[Math.floor(rand() * pool.length)] ?? pool[0]!;
  return first ? line.replace("{name}", first) : line;
}
