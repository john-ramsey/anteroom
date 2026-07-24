/**
 * Settings · colour theme + blackjack layout. Cycle through built-in presets AND your own
 * saved schemes on the "theme" row, edit any role's hex inline, save the current colours
 * under a name, or delete one of your custom schemes (built-ins can't be deleted). Changes
 * apply LIVE (the preview + whole app re-theme/re-layout immediately) and persist on the way out.
 */
import type { Key, Terminal } from "../terminal.ts";
import { accent, accent2, applyTheme, bold, dim, neg, pos, setCountryMode, setLayout, warn } from "../ui.ts";
import { screen, sizeCanvas } from "./canvas.ts";
import { bjSampleBoard } from "./games/blackjack.ts";
import {
  COUNTRY_MODES,
  isBuiltinTheme,
  isHex,
  MAX_THEME_NAME,
  normHex,
  normThemeName,
  PRESETS,
  ROLE_DESC,
  saveSettings,
  THEME_ROLES,
  themeNameError,
  themeNameOf,
  type BjLayout,
  type Settings,
  type ThemeRole,
} from "../settings.ts";

const PRESET_NAMES = Object.keys(PRESETS);
const ROLE_FN: Record<ThemeRole, (s: string) => string> = {
  primary: accent,
  secondary: accent2,
  win: pos,
  lose: neg,
  warn,
};
type Row = "theme" | ThemeRole | "save" | "delete" | "layout" | "country" | "done";
const ROWS: Row[] = ["theme", ...THEME_ROLES, "save", "delete", "layout", "country", "done"];
const countryHint: Record<string, string> = {
  auto: "flag where supported, else code",
  flag: "always the flag emoji",
  code: "always the ISO code",
  off: "hidden",
};
const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
const layoutLabel = (l: BjLayout): string => (l === "big" ? "big cards" : "compact (one-line)");
const rule = (): string => dim("  " + "─".repeat(34));
/** Height of the boxed COMPACT sample board (bjCompactLines for 1 seat = 3 content + 2 borders)
 *  — the smallest preview worth showing; below this the row is an honest "too short" hint. */
const COMPACT_SAMPLE_ROWS = 5;

export function runSettings(term: Terminal, settings: Settings): Promise<Settings> {
  return new Promise((resolve) => {
    const working: Settings = {
      theme: { ...settings.theme },
      layout: settings.layout,
      country: settings.country,
      customThemes: { ...settings.customThemes },
      recent: [...settings.recent], // not edited here — carried through so saving settings keeps it
    };
    let sel = 0;
    let editing = false; // inline hex edit on a role row
    let naming = false; // typing a name to save the current scheme
    let buffer = "";
    let nameErr = "";
    applyTheme(working.theme);
    setLayout(working.layout);
    setCountryMode(working.country);

    /** All selectable theme names, presets first then the user's saved schemes. */
    const themeNames = (): string[] => [...PRESET_NAMES, ...Object.keys(working.customThemes)];
    /** The name of the current colours (built-in or custom), or undefined when unsaved. */
    const curName = (): string | undefined => themeNameOf(working.theme, working.customThemes);

    function draw(): void {
      const name = curName();
      const headerName = name ?? "custom (unsaved)";
      const deletable = !!name && !isBuiltinTheme(name);
      const lines: string[] = [];
      ROWS.forEach((row, i) => {
        const here = i === sel;
        const m = here ? accent(bold("▸")) : " ";
        if (row === "save" || row === "layout") lines.push(rule());
        if (row === "theme") {
          lines.push(`${m} ${dim(pad("theme", 11))} ${accent(bold(`‹ ${headerName} ›`))}  ${dim("(enter: next)")}`);
        } else if (row === "save") {
          if (naming && here) {
            const field = `${accent(bold(buffer))}${dim("▏")}`;
            const tail = nameErr ? neg(nameErr) : dim("enter save · esc cancel");
            lines.push(`${m} ${bold("save as")}  ${field}  ${tail}`);
          } else {
            const hint = deletable ? dim(`saved as “${name}”`) : dim("name the current colours");
            lines.push(`${m} ${bold("Save theme as…")}  ${hint}`);
          }
        } else if (row === "delete") {
          const label = deletable ? bold("Delete theme") : dim("Delete theme");
          const hint = deletable ? dim(`removes “${name}”`) : dim("(custom schemes only)");
          lines.push(`${m} ${label}  ${hint}`);
        } else if (row === "layout") {
          lines.push(`${m} ${dim(pad("layout", 11))} ${accent(bold(layoutLabel(working.layout)))}  ${dim("(enter: toggle)")}`);
        } else if (row === "country") {
          lines.push(`${m} ${dim(pad("country", 11))} ${accent(bold(working.country))}  ${dim(`(enter: cycle) ${countryHint[working.country]}`)}`);
        } else if (row === "done") {
          lines.push(`${m} ${bold("Save & back")}`);
        } else {
          const fn = ROLE_FN[row];
          const value = editing && here ? `#${buffer}${dim("▏")}` : working.theme[row];
          lines.push(`${m} ${dim(pad(row, 11))} ${fn(bold(value))}  ${fn("████")}  ${dim(ROLE_DESC[row])}`);
        }
      });
      const note = editing
        ? "type 6 hex digits · enter apply · esc cancel"
        : naming
          ? `type a name (≤${MAX_THEME_NAME}) · enter save · esc cancel`
          : "↑/↓ move · enter edit / cycle / toggle / save / delete · q save & back";
      // ONE live preview: the blackjack sample board — it shows the theme's colours AND the
      // selected layout in the same panel. It gets whatever height the rows leave over,
      // threaded through the live board's fit ladder so the canvas never amputates it
      // (the old two-preview stack overflowed and lost its bottom at 80 cols).
      const content = [...lines, ""];
      const budget = sizeCanvas(term).CH - 1 - content.length; // canvas body minus rows + separator
      const caption = working.layout === "big" ? 1 : 0; // reserve the "shown compact" row up front
      if (budget - caption >= COMPACT_SAMPLE_ROWS) {
        const board = bjSampleBoard(budget - caption).split("\n");
        content.push(...board);
        // The ladder fell back (a big-cards sample can't fit this window): say so, or the
        // layout toggle would look like it does nothing.
        if (working.layout === "big" && board.length <= COMPACT_SAMPLE_ROWS) {
          content.push(dim("  big cards — shown compact for this window"));
        }
      } else {
        content.push(dim("  (window too short for the board preview)"));
      }
      screen(term, "Settings", content, note);
    }

    function finish(): void {
      off();
      void saveSettings(working).finally(() => resolve(working));
    }

    /** Select the next theme in the combined preset+custom list and apply it live. */
    function cycleTheme(): void {
      const names = themeNames();
      const cur = curName();
      const idx = cur ? names.indexOf(cur) : -1;
      const next = names[(idx + 1) % names.length]!;
      working.theme = { ...(PRESETS[next] ?? working.customThemes[next])! };
      applyTheme(working.theme);
    }

    function onHexKey(k: Key): void {
      const role = ROWS[sel] as ThemeRole;
      if (k.name === "escape") {
        editing = false;
        buffer = "";
      } else if (k.name === "return") {
        if (isHex(`#${buffer}`)) {
          working.theme = { ...working.theme, [role]: normHex(`#${buffer}`) };
          applyTheme(working.theme);
        }
        editing = false;
        buffer = "";
      } else if (k.name === "backspace") {
        buffer = buffer.slice(0, -1);
      } else if (/^[0-9a-f]$/.test(k.char) && buffer.length < 6) {
        buffer += k.char;
      }
      draw();
    }

    function onNameKey(k: Key): void {
      if (k.name === "escape") {
        naming = false;
        buffer = "";
        nameErr = "";
      } else if (k.name === "return") {
        const err = themeNameError(buffer);
        if (err) {
          nameErr = err; // stay in the field so the user can fix it
        } else {
          const nm = normThemeName(buffer);
          working.customThemes = { ...working.customThemes, [nm]: { ...working.theme } };
          naming = false;
          buffer = "";
          nameErr = "";
        }
      } else if (k.name === "backspace") {
        buffer = buffer.slice(0, -1);
        nameErr = "";
      } else if (/^[a-z0-9 _-]$/.test(k.char) && buffer.length < MAX_THEME_NAME) {
        buffer += k.char;
        nameErr = "";
      }
      draw();
    }

    function onKey(k: Key): void {
      if (editing) return onHexKey(k);
      if (naming) return onNameKey(k);
      if (k.name === "up") sel = (sel - 1 + ROWS.length) % ROWS.length;
      else if (k.name === "down") sel = (sel + 1) % ROWS.length;
      else if (k.char === "q") return finish();
      else if (k.name === "return") {
        const row = ROWS[sel];
        if (row === "done") return finish();
        if (row === "theme") {
          cycleTheme();
        } else if (row === "save") {
          naming = true;
          // Pre-fill with the current custom name so re-saving updates it in place.
          const cur = curName();
          buffer = cur && !isBuiltinTheme(cur) ? cur : "";
          nameErr = "";
        } else if (row === "delete") {
          const cur = curName();
          if (cur && !isBuiltinTheme(cur)) {
            const { [cur]: _removed, ...rest } = working.customThemes;
            working.customThemes = rest;
            // Colours stay on screen (now an unnamed "custom"); the user can re-save anytime.
          }
        } else if (row === "layout") {
          working.layout = working.layout === "big" ? "compact" : "big";
          setLayout(working.layout);
        } else if (row === "country") {
          const idx = COUNTRY_MODES.indexOf(working.country);
          working.country = COUNTRY_MODES[(idx + 1) % COUNTRY_MODES.length]!;
          setCountryMode(working.country);
        } else {
          editing = true;
          buffer = "";
        }
      } else return;
      draw();
    }
    const off = term.onKey(onKey);
    draw();
  });
}
