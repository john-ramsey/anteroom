/**
 * "There's a newer version" — the one outbound request the client makes that isn't the game.
 *
 * A CLI you install once and run for months has no other way to tell you it's stale, so at startup
 * this asks the npm registry what the latest published `anteroom` is and, if it's ahead of the
 * running build, the shell shows a toast. That's the whole feature.
 *
 * It is built to be un-noticeable when it fails or has nothing to say:
 *   • at most ONE request a day, remembered in ~/.config/anteroom/update.json, so ten starts in an
 *     afternoon make one request;
 *   • a hard timeout, and every error path (offline, 500, junk body, unreadable cache, read-only
 *     home) resolves to "no news" — a version check must never be the reason a game doesn't start;
 *   • it is fire-and-forget: the caller never awaits it before showing the menu;
 *   • it can be switched off entirely — see `updateCheckEnabled` — and then makes no request.
 *
 * What crosses the wire is a plain unauthenticated GET for a public package document. No identity,
 * no telemetry, nothing about you or your machine beyond what any HTTP request carries. That is
 * worth stating plainly because the product's privacy claim is specific (see docs/disclaimer.md) —
 * and it is why the request is BOTH documented there and opt-out-able rather than simply quiet.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What we remember between runs so a restart doesn't re-ask. */
export interface UpdateCache {
  /** When the registry was last asked (epoch ms). */
  checkedAt: number;
  /** The latest version it reported. */
  latest: string;
}

/** Ask the registry at most this often. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Give up on the registry quickly — this races the menu appearing. */
const FETCH_TIMEOUT_MS = 2_500;
const REGISTRY_URL = "https://registry.npmjs.org/anteroom/latest";

const cacheFile = (): string => join(homedir(), ".config", "anteroom", "update.json");

/**
 * Compare two dotted version strings. Returns 1 if `a` is newer, −1 if older, 0 if equal.
 *
 * Numeric, segment by segment — `1.0.10` is newer than `1.0.9`, which a string comparison gets
 * backwards. A missing segment is 0 (`1.1` === `1.1.0`), and a prerelease sorts BELOW its release
 * (`1.0.4-beta.1` < `1.0.4`) so a beta never nags a stable build. Junk parses as zeros rather than
 * throwing: this reads a remote document, and the failure mode for a surprising one is silence.
 * PURE.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = "", ...rest] = String(v).trim().split("-");
    return {
      nums: core.split(".").map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      }),
      pre: rest.length > 0,
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  return x.pre ? -1 : 1; // a prerelease is older than the release it precedes
}

export interface UpdateCheckDeps {
  /** The running build's version. */
  current: string;
  now: number;
  read: () => Promise<UpdateCache | null>;
  write: (cache: UpdateCache) => Promise<void>;
  /** The latest published version, or null if it couldn't be determined. */
  fetchLatest: () => Promise<string | null>;
}

/**
 * The newer published version, or null when there's nothing to say. Every failure is a null:
 * the caller's job is to toast a string, not to handle the internet.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<string | null> {
  let cache: UpdateCache | null = null;
  try {
    cache = await deps.read();
  } catch {
    /* an unreadable cache just means we ask again */
  }

  let latest = cache?.latest ?? null;
  const fresh = cache !== null && deps.now - cache.checkedAt < CHECK_INTERVAL_MS;
  if (!fresh) {
    try {
      latest = await deps.fetchLatest();
    } catch {
      return null; // offline / refused / timed out — no news
    }
    if (latest === null || latest === "") return null;
    try {
      await deps.write({ checkedAt: deps.now, latest });
    } catch {
      /* a read-only home directory costs us the cache, not the check */
    }
  }

  if (latest === null || latest === "") return null;
  return compareVersions(latest, deps.current) > 0 ? latest : null;
}

/** Read the on-disk cache (null when absent or unparseable). */
export async function readUpdateCache(): Promise<UpdateCache | null> {
  const raw = JSON.parse(await readFile(cacheFile(), "utf8")) as Partial<UpdateCache>;
  if (typeof raw?.checkedAt !== "number" || typeof raw?.latest !== "string") return null;
  return { checkedAt: raw.checkedAt, latest: raw.latest };
}

export async function writeUpdateCache(cache: UpdateCache): Promise<void> {
  await mkdir(dirname(cacheFile()), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(cache), "utf8");
}

/** Ask the npm registry for the latest published version. Null on anything unexpected. */
export async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: unknown };
  return typeof body?.version === "string" ? body.version : null;
}

/**
 * Is the check switched on? PURE.
 *
 * It is the only outbound request the client makes that isn't the game server, and it goes to a
 * third party — npm's public registry, the same host `npm i -g anteroom` already talks to. It
 * carries no identity and no telemetry, but it still reveals an IP and a launch time to someone
 * outside the game's trust boundary, and the privacy policy is specific enough that an
 * undisclosed request doesn't belong in it. So: documented, and switchable off.
 *
 * `ANTEROOM_NO_UPDATE_CHECK` is ours; `NO_UPDATE_NOTIFIER` is the convention other CLIs use (a
 * player who has already turned nags off globally shouldn't have to learn our spelling); `CI`
 * because a build agent is not a player. An empty or `0`/`false` value does NOT opt out — that is
 * how a shell profile unsets an inherited variable.
 */
export function updateCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const on = (v: string | undefined): boolean =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return !(on(env["ANTEROOM_NO_UPDATE_CHECK"]) || on(env["NO_UPDATE_NOTIFIER"]) || on(env["CI"]));
}

export interface FindNewerOpts {
  /**
   * The player's saved preference (`Settings.updateCheck`, toggled on the Settings screen).
   * Either this or the environment switch being off means no request: they are independent
   * ways to say the same "don't" and neither overrides the other.
   */
  enabled?: boolean;
  env?: Record<string, string | undefined>;
  /** Test seams (the real cache + registry by default). */
  deps?: Partial<UpdateCheckDeps>;
}

/**
 * The wired-up check for the app shell: resolves to the newer version, or null. Never rejects, so
 * a caller can `void`-fire it and toast whatever comes back. Returns null WITHOUT touching the
 * network when the check is switched off — by the setting or by the environment.
 */
export async function findNewerVersion(current: string, opts: FindNewerOpts = {}): Promise<string | null> {
  const { enabled = true, env = process.env, deps = {} } = opts;
  if (!enabled || !updateCheckEnabled(env)) return null;
  try {
    return await checkForUpdate({
      current,
      now: Date.now(),
      read: readUpdateCache,
      write: writeUpdateCache,
      fetchLatest: fetchLatestVersion,
      ...deps,
    });
  } catch {
    return null;
  }
}
