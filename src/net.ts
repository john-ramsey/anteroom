/**
 * Network helpers shared by the menu + game sessions: HTTP room allocation, the
 * matchmaker handshake, and the leaderboard fetch. All transport is game-agnostic;
 * the protocol types come from @anteroom/protocol.
 */
import {
  decode,
  encode,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type MeRequest,
  type MeResponse,
  type ServerEvent,
  type ServerMessage,
  type WalletSnapshot,
} from "@anteroom/protocol";
import { sanitizeText } from "./ui.ts";

/** ws://host → http://host (and wss → https). */
export function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/** Allocate a fresh room code from the server (`GET /new`). */
export async function allocateRoom(server: string, game: string): Promise<string> {
  const res = await fetch(`${httpBase(server)}/new?game=${encodeURIComponent(game)}`);
  const data = (await res.json()) as { room: string };
  return data.room;
}

/** Thrown by `matchmake` when the caller aborts the search (the user pressed cancel). The app
 *  shell catches it and quietly returns to the menu — it is NOT a connection error. */
export class MatchmakeCancelled extends Error {
  constructor() {
    super("matchmaking cancelled");
    this.name = "MatchmakeCancelled";
  }
}

/**
 * Queue on the matchmaker and resolve once matched: same-ante players pair into a
 * table. `onSearching` fires when the queue accepts us, carrying the SOFT [minMs, maxMs]
 * wait band (so the caller can show an "est. wait" range alongside a live count-up).
 * Returns the room code + the matchmaker-pinned ante. Any seats the matchmaker pre-fills
 * are already on the table server-side, so the client just joins normally.
 *
 * Pass an `AbortSignal` to make the search cancellable: aborting closes the `/find` socket
 * (releasing the queue slot) and rejects with `MatchmakeCancelled`.
 */
export function matchmake(
  server: string,
  game: string,
  ante: number,
  identity: { token?: string; name: string },
  onSearching?: (band: { minMs: number; maxMs: number }) => void,
  signal?: AbortSignal,
): Promise<{ room: string; ante: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MatchmakeCancelled());
    const ws = new WebSocket(`${server}/find?game=${encodeURIComponent(game)}&ante=${ante}`);
    // Cancel: close the queue socket (drops our slot server-side) and reject so the caller can
    // return to the menu. Registered with `once` and cleared on resolve/error so it never leaks.
    const onAbort = (): void => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new MatchmakeCancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Every exit runs through here exactly once. The queue can end four ways — matched, refused,
    // closed, socket error — and before this guard existed only the first two were wired up, so a
    // refusal (the server's `error` frame + a 1008 close) left the promise pending forever and the
    // player sat on "searching for a table" with nothing to read.
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return true;
    };
    // Authenticate the queue slot like `join`; dev/self-host falls back to a guest name.
    ws.addEventListener("open", () =>
      ws.send(encode({ type: "find_match", game, ante, token: identity.token, name: identity.name })),
    );
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = decode<ServerMessage>(ev.data as string);
      if (msg.type === "searching") {
        onSearching?.({ minMs: msg.minMs, maxMs: msg.maxMs });
      } else if (msg.type === "matched") {
        // Join with the matchmaker-pinned ante so the table matches what we queued for.
        if (settle()) resolve({ room: msg.room, ante: msg.ante });
      } else if (msg.type === "error") {
        // The refusal is worth showing verbatim — "sign in with GitHub to play" is the whole
        // answer for a signed-out player. Strip control bytes first: this string is server-supplied
        // and lands in a terminal.
        if (settle()) reject(new Error(`matchmaking refused: ${sanitizeText(msg.message)}`));
      }
    });
    ws.addEventListener("close", () => {
      // A refused queue closes cleanly (1008), which fires no `error` event — without this the
      // promise would never settle.
      if (settle()) reject(new Error("matchmaking closed before a match was found"));
    });
    ws.addEventListener("error", (e: Event) => {
      if (settle()) reject(new Error("matchmaking failed: " + ((e as ErrorEvent).message ?? "")));
    });
  });
}

/**
 * The outcome of asking the server where we stand.
 *
 * `unauthorized` means the identity itself was refused (sign in again). `unavailable` means we
 * could not ask — an outage, a rate limit, a dropped connection, a body we can't read. The two
 * must stay apart: the server takes care to distinguish them, and treating an outage as a
 * rejection is how a client ends up discarding a perfectly good token.
 */
export type MeResult =
  | { ok: true; snapshot: WalletSnapshot; events?: ServerEvent[] }
  | { ok: false; reason: "unauthorized" | "unavailable" };

/**
 * How long we'll wait for `/me`. Deliberately LONGER than the server's own 5s bound on verifying
 * a token with GitHub: matching it would mean giving up in the same breath as the answer arrives,
 * on exactly the slow-upstream call this is waiting for. A refused connection fails immediately
 * either way, and the request is fired before the menu draws, so this is not a wait the player
 * usually sees.
 */
const ME_TIMEOUT_MS = 6_000;

/** An event we're willing to show: the two fields the client actually renders it by. The
 *  envelope is deliberately open-ended (an unknown `kind` still renders its `text`), which is
 *  exactly why the shape it arrives in gets checked rather than assumed. */
function renderableEvent(v: unknown): v is ServerEvent {
  const e = v as Partial<ServerEvent> | null;
  return !!e && typeof e === "object" && typeof e.id === "string" && typeof e.text === "string";
}

/** A snapshot we're willing to size a real stake against: three finite, non-negative numbers. */
function validSnapshot(v: unknown): v is WalletSnapshot {
  const s = v as Partial<WalletSnapshot> | undefined;
  return (
    !!s &&
    [s.balance, s.available, s.held].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  );
}

/**
 * The player's authoritative chip position (`POST /me`), read from the Wallet DO — NOT the
 * lagging leaderboard mirror, because the stake picker sizes a real bet against it.
 *
 * The token rides in an `Authorization` header, never the URL: URLs are logged and cached.
 * `name` only names a tokenless dev identity; the server ignores it for anyone verified.
 *
 * `ack` names events already shown to the player. It rides this request rather than costing one
 * of its own, and until an event is acked the server keeps handing it back — so a message about
 * the player's own chips survives a response that never arrived.
 */
export async function fetchMe(
  server: string,
  identity: { token?: string; name: string },
  ack: string[] = [],
): Promise<MeResult> {
  try {
    const res = await fetch(`${httpBase(server)}/me`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(identity.token ? { Authorization: `Bearer ${identity.token}` } : {}),
      },
      body: JSON.stringify({ name: identity.name, ...(ack.length > 0 ? { ack } : {}) } satisfies MeRequest),
      signal: AbortSignal.timeout(ME_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: res.status === 401 ? "unauthorized" : "unavailable" };
    const body = (await res.json()) as MeResponse;
    // A number we can't use is worse than no number — it would size a stake off NaN.
    if (!validSnapshot(body?.snapshot)) return { ok: false, reason: "unavailable" };
    const events = Array.isArray(body.events) ? body.events.filter(renderableEvent) : [];
    return { ok: true, snapshot: body.snapshot, ...(events.length > 0 ? { events } : {}) };
  } catch {
    // Timeout, DNS, TLS, unreadable body: we learned nothing, which is not a rejection.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * What to acknowledge on the NEXT `/me`, given what this one returned. PURE.
 *
 * Three cases, and the middle one is the easy bug: a call that succeeds with nothing waiting
 * CLEARS the list, because the previous batch was acknowledged by that very request. Leaving it
 * in place would re-send the same dead ids on every call for the rest of the session. A call that
 * FAILED acknowledges nothing — the server never heard us, so those events are still owed and
 * must ride the next attempt.
 */
export function nextAcks(previous: string[], result: MeResult): string[] {
  if (!result.ok) return previous;
  return result.events?.map((e) => e.id) ?? [];
}

/** Fetch the cross-room leaderboard (`GET /leaderboard`), ranked by `sort` (chips default, or
 *  `wl`). The default omits the param so it hits the same canonical cache entry as today; only
 *  the W/L board carries `?sort=wl`. Empty on any failure. */
export async function fetchLeaderboard(
  server: string,
  sort: "chips" | "wl" = "chips",
): Promise<LeaderboardEntry[]> {
  try {
    const query = sort === "wl" ? "?sort=wl" : "";
    const res = await fetch(`${httpBase(server)}/leaderboard${query}`);
    if (!res.ok) return [];
    const { leaderboard } = (await res.json()) as LeaderboardResponse;
    return leaderboard;
  } catch {
    return [];
  }
}
