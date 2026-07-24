/**
 * Wire protocol shared by the client and the server.
 *
 * The protocol is game-agnostic: `move` payloads and `view` snapshots are opaque
 * (`unknown`) at this layer. Only the game rules and the client renderer interpret
 * their shapes; the server passes them through opaquely.
 */

/**
 * Full match lifecycle. Friendly (no-stakes) matches only ever emit
 * "lobby" | "playing" | "complete"; "ante"/"settling" appear once a match is staked.
 */
export type RoomStatus = "lobby" | "ante" | "playing" | "settling" | "complete";

/** Upper bound on a per-player ante (chips). The server clamps to this; the client
 *  caps its stake picker + `--ante` to match. Keeps the pot arithmetic sane. */
export const MAX_ANTE = 200;

export interface PlayerInfo {
  /** Stable player id: a verified `gh:<numericId>` (token join) or the display name
   *  (tokenless dev join). The server keys the player's chips and match seat off this. */
  id: string;
  /** Human-facing display name (may differ from `id`). */
  name: string;
  /** 0-based seat index. */
  seat: number;
  /** ISO-3166 alpha-2 country from the edge (best-effort; absent in dev/tests). */
  country?: string;
}

export interface JoinConfig {
  /** Game module id, e.g. "rps". Defaults server-side. */
  game?: string;
  /** Best-of-N rounds. Defaults server-side. */
  bestOf?: number;
  /** Per-player ante in chips. 0 (default) = friendly match, no stake — preserves
   *  the original no-stakes behavior exactly. > 0 makes it a staked match. */
  ante?: number;
}

export interface MatchResult {
  /** Winning player id, or null for a draw. */
  winner: string | null;
  scores: Record<string, number>;
}

/**
 * One row of the cross-room leaderboard. Served as plain JSON from
 * `GET /leaderboard` (not a WebSocket message); display-only ranking data.
 */
export interface LeaderboardEntry {
  /** 1-based position (ties broken by user id). */
  rank: number;
  /** Stable player id: `gh:<numericId>` (verified) or a dev display name. Used for
   *  self-highlighting; not shown directly. */
  userId: string;
  /** Display name (chosen username; falls back to the id when none set). */
  name: string;
  /** Current chip balance (the ranking key). */
  balance: number;
  /** Matches finished ahead (settlement delta > 0). */
  wins: number;
  /** Matches finished behind (settlement delta < 0). */
  losses: number;
}

/** `GET /leaderboard` response body. */
export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
}

/** A player's chip position, as reported by the server. */
export interface WalletSnapshot {
  /** Total chips owned (available + held). */
  balance: number;
  /** Spendable now (balance - held). */
  available: number;
  /** Reserved by open holds. */
  held: number;
}

/** Client -> Server. */
export type ClientMessage =
  // The first message on a connection. Carries identity + (for the room creator)
  // config. `token` is a GitHub device-flow access token; when present the server
  // verifies it and keys the player off the verified `gh:<numericId>` (else display name).
  // `spectateIfFull`: when the table is already full, watch it read-only instead of being
  // refused — the "Join Room → play if there's a seat, else spectate" flow. Ignored when a
  // seat is open (you're seated as a player) or the room is empty (you create + wait).
  | { type: "join"; name: string; token?: string; config?: JoinConfig; spectateIfFull?: boolean }
  // Sent to the matchmaker (not a room): find me a table for this game/ante. `token`/`name`
  // authenticate the waiter exactly like `join`; dev allows a tokenless guest.
  | { type: "find_match"; game: string; ante?: number; token?: string; name?: string }
  // A game move. Payload shape is defined by the active game module.
  | { type: "move"; move: unknown }
  // Propose/accept the per-player ante in the lobby of a staked match.
  | { type: "bet"; ante: number }
  // Host (seat 0) signals the lobby is ready to start a non-auto-start match;
  // in a staked match, a player's confirmation that they will ante.
  | { type: "ready" }
  // Start a fresh match with the same players/config.
  | { type: "rematch" }
  | { type: "ping" };

/** Server -> Client. */
export type ServerMessage =
  | {
      type: "joined";
      you: PlayerInfo;
      room: string;
      game: string;
      bestOf: number;
      status: RoomStatus;
      players: string[];
      /** True for a continuous table (rounds loop until you leave) vs a one-shot match. */
      continuous: boolean;
      /** True when you joined as a read-only SPECTATOR (the table was full): you receive the
       *  public board (`state`/`result`/`round`) but hold no seat and can't act. `you.id` is
       *  the `@spectator` sentinel. Absent/false for a normal seated join. */
      spectator?: boolean;
    }
  // Per-player redacted snapshot. `view` is whatever the game's view(state, player) returns.
  // `turnDeadline` (epoch ms) is the per-move decision clock, when one is armed — the
  // client shows a countdown for the player(s) who currently owe a move. `nextRoundAt`
  // (epoch ms) is the pending between-rounds deadline, when one is armed — so a client that
  // joins or reconnects MID-GAP picks the countdown up from the snapshot, not just from the
  // one-shot `result` frame.
  | { type: "state"; view: unknown; status: RoomStatus; turnDeadline?: number; nextRoundAt?: number }
  | {
      type: "opponent";
      // `disconnected` = a transient socket drop (a grace/reconnect may follow); `left` =
      // removed from the table (drop for inactivity, ante timeout, voluntary leave).
      event: "joined" | "left" | "reconnected" | "disconnected";
      name: string;
      /** The other player's id + country, so the client can label them on the board. */
      id?: string;
      country?: string;
      /** True when this frame is BACKFILL: a snapshot of the roster that already existed the
       *  moment you arrived (a spectator's roster replay, or players already seated as you sat
       *  down) — NOT a live arrival. The client updates its roster labels silently for these (no
       *  "X joined" toast); it only narrates people who arrive AFTER you (and greets you with a
       *  dealer line on arrival instead). */
      backfill?: boolean;
    }
  // `nextRoundAt` (epoch ms, same convention as `turnDeadline`) is when a continuous table
  // will deal the next round — the client counts down to it between rounds. Absent on a
  // one-shot match or when the table is ending (no humans / not enough seats).
  | { type: "result"; result: MatchResult; nextRoundAt?: number }
  // --- staked-match (ante > 0) economy messages ---------------------------
  // Lobby snapshot for a staked match: who's here, the table ante, each player's
  // current balance, and whether everyone has confirmed they'll ante.
  | {
      type: "lobby";
      players: PlayerInfo[];
      ante: number | null;
      balances: Record<string, number>;
      everyoneReady: boolean;
    }
  // The ante window opened; `deadline` is epoch ms after which an unmet ante is cancelled.
  | { type: "ante"; deadline: number; ante: number }
  // Outcome of the ante: everyone staked ("escrowed", with the pot) or it was
  // cancelled ("aborted", naming the player who didn't ante).
  | { type: "ante_result"; outcome: "escrowed" | "aborted"; pot?: number; offender?: string }
  // Per-match money outcome: signed chip delta per player and their post-settle balances.
  | {
      type: "settlement";
      pot: number | null;
      deltas: Record<string, number>;
      balances: Record<string, number>;
    }
  // A new round began at a continuous table (blackjack). The client resets its
  // per-round UI state (deal animation, etc.) and plays on.
  | { type: "round"; roundIdx: number }
  // The continuous table cannot continue (the roster fell below the game's minimum, or no
  // humans remain, and the spectator queue couldn't refill the seats): no further round will
  // deal. Always broadcast — an advertised `nextRoundAt` is never silently abandoned. Clients
  // leave the table on receipt.
  | { type: "table_end"; reason: "players" }
  // Pushed to a player after a grant/settle so the client can refresh its display.
  | { type: "balance"; snapshot: WalletSnapshot }
  // --- matchmaker channel (the /find socket, not a room) -------------------
  // Queued. `etaMs` is this waiter's own soft deadline for being matched. `minMs`/`maxMs` are the
  // SOFT window bounds the client shows as an "est. wait" range — deliberately a band, not an exact
  // moment, so the match timing isn't telegraphed.
  | { type: "searching"; etaMs: number; minMs: number; maxMs: number }
  // Sent to a SPECTATOR who is auto-queued for the next seat: their 1-based place in line
  // (`pos`) out of `size` waiting watchers. Re-sent whenever the queue changes (someone ahead is
  // promoted into a seat, or a watcher leaves). When a seat opens at a round boundary the
  // longest-waiting watcher is promoted and receives a fresh `joined` (now as a seated player).
  | { type: "queue"; pos: number; size: number }
  // Found a table: connect to `room` and join. Any seats the matchmaker pre-filled are
  // already on the table server-side (the client never asks), so the join's `joined` roster
  // carries them. `ante` is the matchmaker-agreed stake — the client joins with THIS (pinning
  // it into the room) so the table ante can't diverge from what was queued for.
  | { type: "matched"; room: string; ante: number }
  | { type: "error"; message: string }
  | { type: "pong" };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a JSON wire frame. The protocol layer is transport-agnostic and deals
 * only in strings; callers that may receive binary frames decode to a string first.
 */
export function decode<T = ClientMessage | ServerMessage>(raw: string): T {
  return JSON.parse(raw) as T;
}
