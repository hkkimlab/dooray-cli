import stringWidth from "string-width";
import { DoorayError, errorMessage, exitCode, usageError } from "./errors.js";

export type Format = "table" | "json" | "csv";

export interface Table {
  columns: string[];
  rows: string[][];
}

export interface Writers {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface Printer {
  readonly format: Format;
  /** json mode prints jsonValue; table/csv modes print t. */
  emit(jsonValue: unknown, t: Table): void;
  /** Human progress/status line on stderr; suppressed by --quiet. */
  info(msg: string): void;
  error(err: unknown): void;
}

export function parseFormat(s: string): Format {
  if (s === "table" || s === "json" || s === "csv") return s;
  throw usageError(`invalid format: ${s} (table|json|csv)`);
}

/** Borderless, space-aligned table (like the Go tablewriter setup), CJK-width aware. */
export function renderTable(t: Table): string {
  const all = [t.columns, ...t.rows];
  const widths = t.columns.map((_, i) => Math.max(...all.map((r) => stringWidth(r[i] ?? ""))));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - stringWidth(cell) + 2)))
      .join("")
      .trimEnd();
  return all.map(line).join("\n") + "\n";
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function renderCsv(t: Table): string {
  return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function createPrinter(format: Format, w: Writers, quiet = false): Printer {
  return {
    format,
    emit(jsonValue, t) {
      if (format === "json") w.out(JSON.stringify(jsonValue ?? null, null, 2) + "\n");
      else if (format === "csv") w.out(renderCsv(t));
      else w.out(renderTable(t));
    },
    info(msg) {
      if (!quiet) w.err(msg + "\n");
    },
    error(err) {
      const message = errorMessage(err);
      w.err(`error: ${message}\n`);
      if (format === "json") {
        const apiCode = err instanceof DoorayError ? err.apiCode : 0;
        w.out(JSON.stringify({ error: { code: exitCode(err), message, apiCode } }, null, 2) + "\n");
      }
    },
  };
}

/** Stringifies a cell value; undefined/null become "". */
export const cell = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
