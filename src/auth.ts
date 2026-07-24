/**
 * Client-side GitHub identity.
 *
 * The server is the source of truth for identity — all this module does is obtain a
 * GitHub access token via the OAuth *device flow* (no browser redirect, ideal for a
 * CLI) and cache it. The token is then handed to the server on `join`, which verifies
 * it and ties the player to their verified GitHub account.
 *
 * Device flow:
 *   1. POST /login/device/code        → user_code + verification_uri (+ device_code)
 *   2. user opens the URL, enters the code
 *   3. poll POST /login/oauth/access_token until it returns an access_token
 *
 * Requires a registered GitHub OAuth App client id (with device flow enabled),
 * supplied via `--client-id` or $ANTEROOM_GITHUB_CLIENT_ID.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";

export const IDENTITY_PATH = join(homedir(), ".config", "anteroom", "identity.json");

export interface CachedIdentity {
  /** GitHub access token (passed to the server on join). */
  token: string;
  /** Immutable GitHub numeric account id — the stable, rename-proof account key. */
  id: number;
  /** Verified GitHub login. */
  login: string;
  /** Display name (GitHub profile name, falling back to the login). */
  name: string;
  /** Explicitly chosen display username, if any. Sent on join; when absent the
   *  server assigns the default "First L" display name. */
  username?: string;
}

/** Read the cached identity, or null if none / unreadable. */
export async function loadIdentity(path: string = IDENTITY_PATH): Promise<CachedIdentity | null> {
  try {
    const raw = await readFile(path, "utf8");
    const id = JSON.parse(raw) as Partial<CachedIdentity>;
    if (id.token && id.login && id.id != null) {
      return {
        token: id.token,
        id: id.id,
        login: id.login,
        name: id.name || id.login,
        username: id.username,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the identity to `~/.config/anteroom/identity.json` (owner-only perms). */
export async function saveIdentity(
  id: CachedIdentity,
  path: string = IDENTITY_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(id, null, 2) + "\n", { mode: 0o600 });
}

/** Remove the cached identity (sign out). No-op if nothing is saved. */
export async function deleteIdentity(path: string = IDENTITY_PATH): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already signed out / never saved — nothing to do
  }
}

/**
 * Best-effort: open a URL in the user's default browser so device-flow login doesn't require
 * copy-pasting. NEVER throws — the printed URL + code are always the fallback (headless, SSH,
 * no browser, a locked-down box).
 */
export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // opener missing (e.g. no xdg-open) — swallow
    child.unref();
  } catch {
    // spawn itself failed — the printed URL is the fallback
  }
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

/**
 * Run the GitHub device flow end-to-end: prompt the user with a code/URL, poll for
 * the token, look up their login, cache and return the identity. `sleep` is
 * injectable so a caller/test can avoid real delays.
 */
export async function deviceFlowLogin(
  clientId: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  openUrl: (url: string) => void = openBrowser,
  savePath: string = IDENTITY_PATH,
): Promise<CachedIdentity> {
  if (!clientId) {
    throw new Error(
      "GitHub login needs an OAuth app client id — pass --client-id or set ANTEROOM_GITHUB_CLIENT_ID",
    );
  }

  const codeRes = await fetch(`${GITHUB}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
  });
  if (!codeRes.ok) throw new Error(`device-code request failed (${codeRes.status})`);
  const code = (await codeRes.json()) as DeviceCode;

  console.log(`\n  Opening GitHub to sign in. Enter this code:  ${code.user_code}`);
  console.log(`  (didn't open? go to ${code.verification_uri})\n`);
  openUrl(code.verification_uri); // best-effort; the printed code + URL are the fallback
  console.log("  waiting for authorization…");

  const deadline = Date.now() + code.expires_in * 1000;
  let intervalMs = Math.max(1, code.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const tokRes = await fetch(`${GITHUB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const tok = (await tokRes.json()) as TokenResponse;
    if (tok.access_token) {
      const who = await fetchGitHubUser(tok.access_token);
      const id: CachedIdentity = {
        token: tok.access_token,
        id: who.id,
        login: who.login,
        name: who.name?.trim() || who.login,
      };
      await saveIdentity(id, savePath);
      console.log(`  welcome, ${id.name} (@${id.login})\n`);
      return id;
    }
    // The expected pre-authorization states; everything else is fatal.
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`device flow failed: ${tok.error ?? "unknown error"}`);
  }
  throw new Error("device flow timed out — please try again");
}

async function fetchGitHubUser(token: string): Promise<{ id: number; login: string; name?: string }> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "anteroom",
    },
  });
  if (!res.ok) throw new Error(`GitHub user lookup failed (${res.status})`);
  return (await res.json()) as { id: number; login: string; name?: string };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
