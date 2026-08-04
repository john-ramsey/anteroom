/**
 * CLI argument parsing + the `--help` screen.
 *
 * Split out of `index.ts` so it stays PURE and unit-testable: importing `index.ts` launches the
 * client, so anything tested has to live outside it. The build-baked defaults (server URL,
 * OAuth client id) are resolved by the caller and passed in, which keeps this module free of
 * `process.env` and the esbuild `--define` globals.
 *
 * Two flags were deliberately REMOVED rather than hidden:
 *   `--server`   — aimed the client at an arbitrary host. The server isn't open source, so the
 *                  CLI shouldn't advertise pointing at one. `ANTEROOM_SERVER` still covers local
 *                  dev and self-hosting (see config.ts `resolveServer`).
 *   `--best-of`  — set the length of an RPS series. A long series makes a seated opponent's
 *                  nature obvious, so the series length is no longer a knob.
 * Both are now unknown tokens: the parser ignores them AND the value that followed them, so a
 * stale command line can't be silently misread.
 */
import { MAX_ANTE, MIN_ANTE } from "@anteroom/protocol";

/** Rounds in an RPS series. Fixed — this used to be the `--best-of` flag. */
export const BEST_OF = 3;

/** A requested `--ante` snapped into what a table will actually accept: 0 (casual, no stake)
 *  or a real stake inside [MIN_ANTE, MAX_ANTE]. Junk parses to 0. */
function clampAnte(v: number): number {
  const n = Math.trunc(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_ANTE, Math.max(MIN_ANTE, n));
}

export interface Args {
  server: string;
  room?: string;
  name: string;
  game: string;
  bestOf: number;
  ante: number;
  isNew: boolean;
  find: boolean;
  token?: string;
  username?: string;
  leaderboard: boolean;
  login: boolean;
  logout: boolean;
  help: boolean;
  devIdentity?: string;
  clientId?: string;
  /** Override the auto-discovered agent marker dirs with one explicit dir (dev). Normally unset —
   *  a bare `anteroom` watches `~/.config/anteroom/agents/*` (see agentWatchDirs). */
  watchClaude?: string;
}

/** Flags that were removed but may still be sitting in someone's shell history or a script.
 *  Listed so the parser can skip the VALUE that follows them too. */
const DROPPED_WITH_VALUE = new Set(["--server", "--best-of"]);

/** Defaults the caller resolved from env + the build-baked values. */
export interface ArgDefaults {
  server: string;
  clientId?: string;
}

export function parseArgs(argv: string[], defaults: ArgDefaults): Args {
  const a: Args = {
    server: defaults.server,
    name: "anon",
    game: "rps",
    bestOf: BEST_OF,
    ante: 0,
    isNew: false,
    find: false,
    login: false,
    logout: false,
    leaderboard: false,
    help: false,
    clientId: defaults.clientId,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    // Swallow a dropped flag together with its value, so `--server ws://x --game craps`
    // can't leave `ws://x` behind to be misparsed.
    if (DROPPED_WITH_VALUE.has(v)) i++;
    else if (v === "--room") a.room = argv[++i];
    else if (v === "--name") a.name = argv[++i] ?? a.name;
    else if (v === "--game") a.game = (argv[++i] ?? a.game).toLowerCase();
    // 0 stays 0 (casual, no stake); any real stake is floored at the house minimum, the same
    // number the server clamps up to — so `--ante 2` can't compute a 2-chip bankroll slice the
    // table would refuse.
    else if (v === "--ante") a.ante = clampAnte(Number(argv[++i]));
    else if (v === "--token") a.token = argv[++i];
    else if (v === "--username") a.username = argv[++i];
    else if (v === "--login") a.login = true;
    else if (v === "--logout") a.logout = true;
    else if (v === "--dev-identity") a.devIdentity = argv[++i];
    else if (v === "--client-id") a.clientId = argv[++i];
    else if (v === "--leaderboard") a.leaderboard = true;
    else if (v === "--new") a.isNew = true;
    else if (v === "--find") a.find = true;
    else if (v === "--watch-claude") a.watchClaude = argv[++i];
    else if (v === "--help" || v === "-h" || v === "help") a.help = true;
  }
  return a;
}

/** True when the invocation is asking for help. Checked before anything else runs, so `--help`
 *  never has to wait on the identity/network path. */
export function wantsHelp(argv: string[]): boolean {
  return argv.some((v) => v === "--help" || v === "-h" || v === "help");
}

/**
 * The `--help` screen. `games` comes from the client's own registry (`listGameUIs()`), so the
 * list can never drift from the games that actually ship.
 *
 * Only PLAYER-facing flags appear. The dev/internal ones (`--name`, `--dev-identity`,
 * `--client-id`, `--token`, `--watch-claude`) still parse but aren't advertised.
 */
export function helpText(games: string[]): string {
  return [
    "Anteroom — play a quick game while a long task runs.",
    "",
    "Usage: anteroom [command] [options]",
    "",
    "Commands:",
    "  (none)               open the main menu",
    "  setup                wire the zero-token hooks into Claude Code / Codex",
    "",
    "Options:",
    "  --find               matchmake into a table",
    "  --new                open a new private room",
    "  --room CODE          join a room by its code",
    `  --game <id>          ${games.join(", ")}`,
    "  --ante N             chips to stake per hand (Stakes tables)",
    "  --login              sign in with GitHub",
    "  --logout             forget the saved sign-in",
    "  --username <name>    set the display name others see",
    "  --leaderboard        print the leaderboard and exit",
    "  --help               show this",
    "",
    "Chips are play money. There is no purchase, payout, or cash value.",
  ].join("\n");
}
