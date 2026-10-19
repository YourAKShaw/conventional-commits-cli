import process from "node:process";

/** Minimal ANSI styling that honours NO_COLOR, FORCE_COLOR and non-TTY streams. */
export function colorEnabled(stream: NodeJS.WriteStream = process.stderr): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

let enabled = colorEnabled();

export function setColor(on: boolean): void {
  enabled = on;
}

const wrap = (open: number, close: number) => (text: string) =>
  enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Write to stdout and resolve once the data is flushed (safe before process.exit). */
export function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

export function writeErr(text: string): void {
  process.stderr.write(text);
}

let verbose = process.env.CCLI_DEBUG === "1";

export function setVerbose(on: boolean): void {
  verbose = on || process.env.CCLI_DEBUG === "1";
}

export function isVerbose(): boolean {
  return verbose;
}

/** Diagnostic line on stderr. Never pass keys or payload content here. */
export function debug(message: string): void {
  if (verbose) writeErr(`${c.gray(`[ccli] ${message}`)}\n`);
}
