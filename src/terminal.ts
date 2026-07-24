/**
 * Terminal layer for the full-screen TUI.
 *
 * On a real TTY this owns the alternate screen buffer, raw single-keypress input, and
 * an in-place full-frame redraw, so the game renders in one fixed place instead of
 * scrolling. When stdout/stdin is NOT a TTY (pipes, CI, redirected output) everything
 * degrades to plain scrolling `console.log` + line input — preserving clean,
 * escape-free output for logs and scripted play.
 *
 * All terminal-control sequences are gated behind `tty`, and `restore()` is wired to
 * every exit path (SIGINT/SIGTERM, raw-mode Ctrl-C, process exit, uncaught errors) so
 * the user's terminal is never left in alt-screen / hidden-cursor / raw mode.
 */
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import { renderToast } from "./ui.ts";

export type ToastKind = "info" | "win" | "warn";
export interface ToastOpts {
  kind?: ToastKind;
  /** Milliseconds before the toast auto-dismisses (default 4000). */
  ms?: number;
}

export interface Key {
  /** Node keypress name: "up","down","left","right","return","space","escape", a letter, … */
  name?: string;
  /** The printable character, lowercased ("" for non-printing keys). */
  char: string;
  ctrl: boolean;
}

export interface Terminal {
  /** True only when both stdout and stdin are TTYs (full-screen mode is possible). */
  readonly tty: boolean;
  readonly columns: number;
  readonly rows: number;
  /** Redraw a full multi-line frame in place (TTY) or print it once (non-TTY). */
  paint(frame: string): void;
  /** Pop a transient toast over the current frame (top-right, auto-dismiss). Off a TTY it
   *  logs the message once. Toasts persist across paint()s until they expire. */
  toast(message: string, opts?: ToastOpts): void;
  /** Pin (or clear, with `null`) a persistent status overlay at the box's top-right — the
   *  "while your model runs" HUD. Survives paint()s; redraws on each change. No-op off a TTY. */
  setStatus(lines: string[] | null): void;
  /** Subscribe to keypresses; returns an unsubscribe fn. Ctrl-C is handled globally. */
  onKey(handler: (key: Key) => void): () => void;
  /** Resolve on the next keypress (one-shot convenience over onKey). */
  readKey(): Promise<Key>;
  onResize(cb: () => void): () => void;
  /** Temporarily leave alt-screen / raw mode (e.g. for an interactive login prompt). */
  suspend(): void;
  resume(): void;
  /** Idempotent teardown: restore the cursor, leave alt-screen, exit raw mode. */
  restore(): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR = "\x1b[2J";

// eslint-disable-next-line no-control-regex
const stripLen = (s: string): number => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

/**
 * Compose active toasts into a cursor-positioned overlay string: each box is right-aligned to
 * `rightEdgeCol` (column = rightEdgeCol − width − 1) starting at `topRow`, stacked downward with
 * a blank row between. Pure (no I/O) so it can be unit-tested; the terminal writes the result
 * after the base frame. Passing the canvas BOX's right edge + top (see `boxAnchor`) lands the
 * toasts inside the framed screen rather than floating at the terminal's very top-right.
 */
export function composeToasts(toasts: { lines: string[] }[], rightEdgeCol: number, topRow = 1): string {
  let row = topRow;
  let buf = "";
  for (const t of toasts) {
    const w = Math.max(0, ...t.lines.map(stripLen));
    const col = Math.max(1, rightEdgeCol - w - 1);
    for (let i = 0; i < t.lines.length; i++) buf += `\x1b[${row + i};${col}H${t.lines[i]}`;
    row += t.lines.length + 1; // a blank row between stacked toasts
  }
  return buf;
}

/**
 * Find the canvas box inside a painted full-screen `frame`: its right-edge column and the first
 * interior row (just inside the top border), so toasts overlay INSIDE the box (top-right) instead
 * of at the terminal's top edge. Falls back to `fallbackCols`/row 1 if no box line is found. Pure.
 */
export function boxAnchor(frame: string, fallbackCols: number): { rightEdgeCol: number; topRow: number } {
  const lines = frame.split("\n");
  let top = 0;
  while (top < lines.length && (lines[top] ?? "").trim() === "") top++;
  const border = lines[top];
  if (border === undefined) return { rightEdgeCol: fallbackCols, topRow: 1 };
  // The border line is `lead spaces + ╭…╮`; its visible length is the box's right-edge column,
  // and the first content row sits one line below the top border.
  return { rightEdgeCol: stripLen(border), topRow: top + 2 };
}

/**
 * The bottom-right interior anchor of the canvas box: the box's right-edge column and the LAST
 * interior row (the canvas's note row, just inside the bottom border). A generic bottom-right
 * pin point (mirror of `boxAnchor`); falls back to `fallbackCols` and `fallbackRows − 1`. Pure.
 */
export function boxAnchorBottom(
  frame: string,
  fallbackCols: number,
  fallbackRows: number,
): { rightEdgeCol: number; bottomRow: number } {
  const lines = frame.split("\n");
  let b = lines.length - 1;
  while (b >= 0 && (lines[b] ?? "").trim() === "") b--;
  const border = lines[b];
  if (border === undefined) return { rightEdgeCol: fallbackCols, bottomRow: Math.max(1, fallbackRows - 1) };
  // 0-based bottom-border index `b` → its 1-based row is `b + 1`; the interior row just above it
  // (the note row) is therefore row `b` (1-based). Same right edge as the matching top border.
  return { rightEdgeCol: stripLen(border), bottomRow: Math.max(1, b) };
}

/**
 * Compose a pinned status overlay: right-align `lines` to `rightEdgeCol` (one space inside the
 * border, like toasts) with the LAST line landing on `bottomRow`. Pure — the terminal writes the
 * result after the base frame so it sits on top; the base rewrite in render() erases a cleared
 * one. Used for the persistent "claude is working" HUD.
 */
export function composeStatus(lines: string[], rightEdgeCol: number, bottomRow: number): string {
  const top = bottomRow - lines.length + 1;
  let buf = "";
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const col = Math.max(1, rightEdgeCol - stripLen(ln) - 1);
    buf += `\x1b[${Math.max(1, top + i)};${col}H${ln}`;
  }
  return buf;
}

/**
 * Compose a pinned status overlay anchored at the box's TOP-right: right-align `lines` to
 * `rightEdgeCol` (one space inside the border, like toasts) with the FIRST line landing on
 * `topRow`, growing downward. Pure (mirror of `composeStatus`). Used for the "while your model
 * runs" HUD now that it lives in the top-right corner.
 */
export function composeStatusTop(lines: string[], rightEdgeCol: number, topRow: number): string {
  let buf = "";
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const col = Math.max(1, rightEdgeCol - stripLen(ln) - 1);
    buf += `\x1b[${Math.max(1, topRow + i)};${col}H${ln}`;
  }
  return buf;
}

export function createTerminal(): Terminal {
  const out = process.stdout;
  const inp = process.stdin;
  const tty = out.isTTY === true && inp.isTTY === true && process.env.NO_COLOR === undefined;

  const keyHandlers = new Set<(k: Key) => void>();
  const resizeHandlers = new Set<() => void>();
  let restored = false;
  let suspended = false;
  let rl: Interface | undefined;

  function quit(): void {
    term.restore();
    process.exit(0);
  }

  function dispatch(key: Key): void {
    if (key.ctrl && key.name === "c") return quit(); // Ctrl-C always exits cleanly
    for (const h of [...keyHandlers]) h(key);
  }

  if (tty) {
    emitKeypressEvents(inp);
    inp.on("keypress", (str: string | undefined, k: { name?: string; ctrl?: boolean } | undefined) => {
      dispatch({ name: k?.name, char: (str ?? "").toLowerCase(), ctrl: k?.ctrl === true });
    });
    out.on("resize", () => {
      for (const h of [...resizeHandlers]) h();
    });
  } else {
    // Non-TTY: line input. Each line yields one key (its first char; empty = return).
    rl = createInterface({ input: inp });
    rl.on("line", (line: string) => {
      const t = line.trim().toLowerCase();
      dispatch({ name: t === "" ? "return" : t, char: t.slice(0, 1), ctrl: false });
    });
    rl.on("close", () => quit());
  }

  function enter(): void {
    if (!tty) return;
    out.write(ALT_ON + CURSOR_HIDE + CLEAR + HOME);
    inp.setRawMode(true);
    inp.resume();
  }

  // --- toasts: transient overlays drawn at the top-right, on top of the base frame --------
  type Toast = { id: number; lines: string[]; timer: ReturnType<typeof setTimeout> };
  const toasts: Toast[] = [];
  let toastSeq = 0;
  let lastFrame = "";
  // The persistent "while your model runs" HUD — pinned top-right, redrawn on every render.
  let status: string[] | null = null;

  /** Overwrite the screen with the stored base frame, then draw active toasts + status on top. */
  function render(): void {
    if (!tty) return;
    const lines = lastFrame.split("\n");
    // Join with "\n" (clear-to-EOL on each line so shorter lines don't ghost) but DON'T append a
    // trailing newline after the last line — a newline on the bottom-most terminal row scrolls the
    // whole buffer up, which pushed the top blank rows (and then the box's top border) off-screen.
    const buf = HOME + lines.map((ln) => ln + "\x1b[K").join("\n") + "\x1b[J"; // clear below = no ghost
    out.write(buf);
    drawToasts();
    drawStatus();
  }
  /** Position each toast inside the canvas box (top-right), stacked downward — drawn AFTER the
   *  base so they sit on top; the base rewrite in render() erases an expired one. When the HUD
   *  status occupies the top-right corner, toasts start BELOW it (a blank row between) so the two
   *  top-right overlays never collide. */
  function drawToasts(): void {
    if (!tty || toasts.length === 0) return;
    const { rightEdgeCol, topRow } = boxAnchor(lastFrame, out.columns ?? 80);
    const offset = status && status.length > 0 ? status.length + 1 : 0;
    out.write(composeToasts(toasts, rightEdgeCol, topRow + offset));
  }
  /** Pin the status overlay (the "while your model runs" HUD) at the box's TOP-right — drawn after
   *  the base so it sits on top; the base rewrite in render() erases it once cleared. */
  function drawStatus(): void {
    if (!tty || status === null || status.length === 0) return;
    const { rightEdgeCol, topRow } = boxAnchor(lastFrame, out.columns ?? 80);
    out.write(composeStatusTop(status, rightEdgeCol, topRow));
  }

  let prevHeight = 0;
  const term: Terminal = {
    tty,
    get columns() {
      return out.columns ?? 80;
    },
    get rows() {
      return out.rows ?? 24;
    },
    paint(frame: string): void {
      if (!tty) {
        console.log(frame);
        return;
      }
      lastFrame = frame;
      prevHeight = frame.split("\n").length;
      render();
    },
    toast(message: string, opts: ToastOpts = {}): void {
      if (!tty) {
        console.log(message);
        return;
      }
      const id = ++toastSeq;
      const lines = renderToast(message, opts.kind ?? "info");
      const timer = setTimeout(() => {
        const idx = toasts.findIndex((t) => t.id === id);
        if (idx >= 0) {
          toasts.splice(idx, 1);
          render();
        }
      }, opts.ms ?? 4000);
      toasts.push({ id, lines, timer });
      render();
    },
    setStatus(lines: string[] | null): void {
      if (!tty) return;
      status = lines && lines.length > 0 ? lines : null;
      render();
    },
    onKey(handler): () => void {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    readKey(): Promise<Key> {
      return new Promise((resolve) => {
        const off = term.onKey((k) => {
          off();
          resolve(k);
        });
      });
    },
    onResize(cb): () => void {
      resizeHandlers.add(cb);
      return () => resizeHandlers.delete(cb);
    },
    suspend(): void {
      if (!tty || suspended) return;
      suspended = true;
      inp.setRawMode(false);
      out.write(CURSOR_SHOW + ALT_OFF);
    },
    resume(): void {
      if (!tty || !suspended) return;
      suspended = false;
      out.write(ALT_ON + CURSOR_HIDE + CLEAR + HOME);
      prevHeight = 0;
      inp.setRawMode(true);
    },
    restore(): void {
      if (restored) return;
      restored = true;
      for (const t of toasts) clearTimeout(t.timer);
      toasts.length = 0;
      status = null;
      if (tty) {
        try {
          inp.setRawMode(false);
        } catch {
          /* not a raw stream */
        }
        out.write(CURSOR_SHOW + ALT_OFF);
      }
      rl?.close();
      try {
        inp.pause();
      } catch {
        /* noop */
      }
    },
  };

  // Restore on every exit path so the terminal is never left in a bad state.
  process.on("exit", () => term.restore());
  process.on("SIGINT", () => quit());
  process.on("SIGTERM", () => quit());
  process.on("uncaughtException", (err) => {
    term.restore();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    term.restore();
    console.error(err);
    process.exit(1);
  });

  enter();
  return term;
}
