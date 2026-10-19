import { spawn } from "node:child_process";
import process from "node:process";
import { CliError } from "../errors.js";
import { debug } from "../term.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when output exceeded `maxBytes` and the process was stopped early. */
  truncated: boolean;
}

export interface GitOptions {
  cwd: string;
  input?: string;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
  /** Stop reading stdout after this many bytes (the process is killed). */
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// Global options applied to every invocation:
// - core.quotepath=off keeps non-ASCII paths readable.
// - --no-pager prevents a pager from waiting on a TTY.
const BASE_ARGS = ["-c", "core.quotepath=off", "--no-pager"];

export class GitError extends CliError {
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], code: number, stderr: string) {
    const summary = stderr.trim().split("\n").slice(-3).join("\n") || `exit code ${code}`;
    super(`git ${args[0] ?? ""} failed: ${summary}`);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Run git with an argument array (never through a shell) and capture output.
 * Read-only commands should not take optional locks, so GIT_OPTIONAL_LOCKS=0 is set.
 */
export function git(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...BASE_ARGS, ...args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          ...options.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: options.signal,
      });
    } catch (error) {
      reject(gitSpawnError(error));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (options.maxBytes !== undefined && outBytes + chunk.length > options.maxBytes) {
        out.push(chunk.subarray(0, Math.max(0, options.maxBytes - outBytes)));
        outBytes = options.maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => reject(gitSpawnError(error)));
    child.on("close", (code) => {
      const result: GitResult = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: truncated ? 0 : (code ?? 1),
        truncated,
      };
      debug(`git ${args.slice(0, 3).join(" ")} → ${result.code} (${Date.now() - started} ms)`);
      if (result.code !== 0 && !options.allowFailure) {
        reject(new GitError(args, result.code, result.stderr));
        return;
      }
      resolve(result);
    });

    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Run git attached to the user's terminal (hooks, GPG pinentry and editors stay interactive). */
export function gitInteractive(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...BASE_ARGS, ...args], {
      cwd,
      stdio: "inherit",
      env: process.env,
      windowsHide: false,
    });
    child.on("error", (error) => reject(gitSpawnError(error)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function gitSpawnError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new CliError("git was not found on your PATH.", {
      hint: "Install Git from https://git-scm.com/downloads and try again.",
    });
  }
  if (code === "ABORT_ERR") return new CliError("Cancelled.");
  return error instanceof Error ? error : new Error(String(error));
}

/** Split NUL-separated git output, dropping the trailing empty field. */
export function splitNul(text: string): string[] {
  const parts = text.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
