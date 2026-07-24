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
  type ServerMessage,
} from "@anteroom/protocol";

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
    // Authenticate the queue slot like `join`; dev/self-host falls back to a guest name.
    ws.addEventListener("open", () =>
      ws.send(encode({ type: "find_match", game, ante, token: identity.token, name: identity.name })),
    );
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = decode<ServerMessage>(ev.data as string);
      if (msg.type === "searching") {
        onSearching?.({ minMs: msg.minMs, maxMs: msg.maxMs });
      } else if (msg.type === "matched") {
        signal?.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        // Join with the matchmaker-pinned ante so the table matches what we queued for.
        resolve({ room: msg.room, ante: msg.ante });
      }
    });
    ws.addEventListener("error", (e: Event) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("matchmaking failed: " + ((e as ErrorEvent).message ?? "")));
    });
  });
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
