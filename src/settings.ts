/**
 * Local client settings — the colour theme + blackjack table layout, persisted at
 * ~/.config/anteroom/settings.json (next to the cached identity).
 *
 * A theme is just a handful of semantic ROLE colours as hex strings; the renderer
 * maps everything (titles, your seat, the dealer, win/loss/push, suits) onto them.
 * Users pick a preset or enter their own hex. Default is orange & blue.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THEME_ROLES = ["primary", "secondary", "win", "lose", "warn"] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];
export type Theme = Record<ThemeRole, string>;

/** Human-readable role descriptions (for the settings screen). */
export const ROLE_DESC: Record<ThemeRole, string> = {
  primary: "accent — titles, your seat, active turn",
  secondary: "secondary — the dealer / opponents",
  win: "win / blackjack",
  lose: "loss / bust / red suits",
  warn: "push / countdown warning",
};

export const PRESETS: Record<string, Theme> = {
  "orange-blue": { primary: "#f2933c", secondary: "#4c9eeb", win: "#4fb05a", lose: "#e5534b", warn: "#e3b341" },
  cyan: { primary: "#36c6d9", secondary: "#c56bd6", win: "#4fb05a", lose: "#e5534b", warn: "#e3b341" },
  slate: { primary: "#6fa8dc", secondary: "#9fb4c7", win: "#79b17a", lose: "#d08c84", warn: "#d9c27a" },
  neon: { primary: "#00e5ff", secondary: "#ff44cc", win: "#00ff66", lose: "#ff3355", warn: "#ffe600" },
  mono: { primary: "#e6e6e6", secondary: "#9e9e9e", win: "#cfcfcf", lose: "#e5534b", warn: "#bdbdbd" },
};

export const DEFAULT_THEME: Theme = { ...PRESETS["orange-blue"]! };

/** Blackjack table layout: "compact" = one-line hands (default — fits every terminal),
 *  "big" = full playing cards (opt-in; the fit ladder still falls back when the window is short). */
export type BjLayout = "big" | "compact";
export const DEFAULT_LAYOUT: BjLayout = "compact";
function isBjLayout(v: unknown): v is BjLayout {
  return v === "big" || v === "compact";
}

/**
 * How a player's country is shown next to their name:
 *  - "auto" (default) — a flag emoji in terminals that render them, else the ISO code
 *  - "flag" — always the flag emoji
 *  - "code" — always the dim ISO code (e.g. BR)
 *  - "off"  — hide country entirely
 * Default is "auto" because flag emoji are unreliable across terminals (many show the two
 * regional-indicator letters instead of a flag) — see ui.detectsFlagSupport.
 */
export type CountryMode = "auto" | "flag" | "code" | "off";
export const COUNTRY_MODES: readonly CountryMode[] = ["auto", "flag", "code", "off"];
export const DEFAULT_COUNTRY: CountryMode = "auto";
function isCountryMode(v: unknown): v is CountryMode {
  return v === "auto" || v === "flag" || v === "code" || v === "off";
}

export interface Settings {
  theme: Theme;
  layout: BjLayout;
  /** How to show players' country next to their names (flag / code / off / auto). */
  country: CountryMode;
  /**
   * Ask the npm registry at startup whether a newer `anteroom` is published (default on).
   *
   * This is the ONLY outbound request the client makes that isn't the game server, so it gets a
   * visible switch rather than only the `ANTEROOM_NO_UPDATE_CHECK` environment variable — that one
   * is for scripts and CI, and a player who would rather the client didn't phone npm shouldn't have
   * to edit a shell profile. Either switch off means no request is made at all. See update.ts.
   */
  updateCheck: boolean;
  /**
   * User-saved colour schemes, keyed by name. These sit alongside the built-in `PRESETS`
   * in the theme picker; unlike presets they can be deleted. Names can never shadow a
   * built-in (enforced on save and on load).
   */
  customThemes: Record<string, Theme>;
  /**
   * Recently played game ids, most-recent-first and de-duplicated — drives the home menu's
   * "Recent" section. Stored as opaque strings (validated against the registry at render time,
   * not here, so settings stays registry-free); capped at `MAX_RECENT`.
   */
  recent: string[];
}

/** How many recent game ids to retain on disk (the menu shows only the first couple). */
export const MAX_RECENT = 8;

/**
 * Move `id` to the front of the recents list, dropping any earlier occurrence and clamping to
 * `max`. Pure — the single source of truth for recents ordering (unit-tested, reused by the shell).
 */
export function pushRecent(recent: string[], id: string, max: number = MAX_RECENT): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

/** Defensively parse the stored recents: strings only, de-duped (first wins), capped at MAX_RECENT. */
export function parseRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/** Max characters in a custom scheme name (keeps the picker tidy). */
export const MAX_THEME_NAME = 24;

/**
 * Does `s` contain a terminal control byte — C0 (0x00–0x1F), DEL (0x7F), or C1 (0x80–0x9F)?
 * A scheme name is drawn verbatim into the terminal (bold/accent/dim), so an ESC or BEL here
 * is a control-sequence injection vector (display spoofing, OSC-52 clipboard writes, …). The
 * interactive entry charset (`/^[a-z0-9 _-]$/`) already excludes these; this guards the on-disk
 * load path, which accepts hand-edited names that never went through that filter.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Names that can't be used as scheme keys: `__proto__` assigned via `out[name] = …` retargets
 * the object's prototype instead of creating a key, so such an entry silently vanishes on reload
 * (and risks prototype pollution).
 */
const RESERVED_NAMES = new Set(["__proto__"]);

/** Trim and collapse internal whitespace in a scheme name. */
export function normThemeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Is `name` one of the built-in presets (which cannot be overwritten or deleted)? */
export function isBuiltinTheme(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

/** Validate a name the user wants to save under; null means OK, else a short reason. */
export function themeNameError(raw: string): string | null {
  const n = normThemeName(raw);
  if (!n) return "name required";
  if (n.length > MAX_THEME_NAME) return `max ${MAX_THEME_NAME} chars`;
  if (hasControlChar(n)) return "invalid characters";
  if (RESERVED_NAMES.has(n)) return "reserved name";
  if (isBuiltinTheme(n)) return "name is a built-in";
  return null;
}

export const SETTINGS_PATH = join(homedir(), ".config", "anteroom", "settings.json");

/** A 6-digit hex colour, with or without a leading `#`. */
export function isHex(s: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(s.trim());
}
/** Normalise to lowercase `#rrggbb`. */
export function normHex(s: string): string {
  return "#" + s.trim().replace(/^#/, "").toLowerCase();
}

/** Parse one stored theme object, returning null unless every role is a valid hex colour. */
function parseTheme(v: unknown): Theme | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out = {} as Theme;
  for (const role of THEME_ROLES) {
    const c = src[role];
    if (typeof c !== "string" || !isHex(c)) return null;
    out[role] = normHex(c);
  }
  return out;
}

/** Defensively load the named-scheme library, dropping malformed or reserved entries. */
export function parseCustomThemes(raw: unknown): Record<string, Theme> {
  const out: Record<string, Theme> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [rawName, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = normThemeName(rawName);
    if (themeNameError(name)) continue; // empty / over-long / control bytes / reserved / shadows a built-in
    const theme = parseTheme(v);
    if (theme) out[name] = theme;
  }
  return out;
}

/** Load settings, falling back to the default theme on any missing/invalid value. */
export async function loadSettings(path: string = SETTINGS_PATH): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      theme?: Partial<Theme>;
      layout?: string;
      flags?: unknown;
      country?: unknown;
      updateCheck?: unknown;
      customThemes?: unknown;
      recent?: unknown;
    };
    const theme: Theme = { ...DEFAULT_THEME };
    for (const role of THEME_ROLES) {
      const v = raw.theme?.[role];
      if (typeof v === "string" && isHex(v)) theme[role] = normHex(v);
    }
    // Validate BOTH values — a one-sided check would silently rewrite the other explicit
    // choice to the default (it did exactly that to "big" when the default flipped to compact).
    const layout: BjLayout = isBjLayout(raw.layout) ? raw.layout : DEFAULT_LAYOUT;
    // Country mode, migrating the old `flags` boolean (false → "off") when it's the only hint.
    const country: CountryMode = isCountryMode(raw.country)
      ? raw.country
      : raw.flags === false
        ? "off"
        : DEFAULT_COUNTRY;
    return {
      theme,
      layout,
      country,
      // Only a real `false` turns it off: a hand-edited "false" (or any other junk) must not
      // silently disable a check the user never actually opted out of.
      updateCheck: typeof raw.updateCheck === "boolean" ? raw.updateCheck : true,
      customThemes: parseCustomThemes(raw.customThemes),
      recent: parseRecent(raw.recent),
    };
  } catch {
    return {
      theme: { ...DEFAULT_THEME },
      layout: DEFAULT_LAYOUT,
      country: DEFAULT_COUNTRY,
      updateCheck: true,
      customThemes: {},
      recent: [],
    };
  }
}

export async function saveSettings(s: Settings, path: string = SETTINGS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** The built-in preset name matching `theme` exactly, or undefined for a custom theme. */
export function presetNameOf(theme: Theme): string | undefined {
  return Object.keys(PRESETS).find((name) =>
    THEME_ROLES.every((r) => PRESETS[name]![r] === theme[r]),
  );
}

/**
 * The name matching `theme` exactly — a built-in preset first, then a saved custom scheme —
 * or undefined when the colours don't match any saved scheme (an unnamed "custom" theme).
 */
export function themeNameOf(theme: Theme, customThemes: Record<string, Theme> = {}): string | undefined {
  const all: Record<string, Theme> = { ...PRESETS, ...customThemes };
  return Object.keys(all).find((name) => THEME_ROLES.every((r) => all[name]![r] === theme[r]));
}
