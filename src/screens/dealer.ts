/**
 * Dealer "table talk" for ARRIVING at a populated casino table.
 *
 * When you sit down at (or pull up a chair to watch) a table that already has players, we do NOT
 * narrate who was already here — those ride in as silent `backfill` opponent frames. Instead the
 * dealer greets you with one of these lines, in the same casino-flavored spirit as the menu's
 * ambient table talk (see intro.ts). One line is dynamic (the clock) so it feels alive.
 */
export function pickWelcome(): string {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const lines = [
    "welcome to the table",
    "the dealer nods — take a seat",
    "you settle in at the felt",
    "the dealer slides you a fresh stack",
    `you glance at the clock — it's ${time}`,
    "the pit boss tips their hat",
    "good seats never stay empty long",
    "the felt's still warm from the last hand",
  ];
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0]!;
}
