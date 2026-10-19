import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, ExitCode } from "../errors.js";
import { git, gitInteractive } from "./git.js";
import type { RepoInfo } from "./repo.js";

const LAST_MESSAGE_FILE = "CCLI_LAST_MESSAGE";

/**
 * Flags that would replace the message ccli commits, or commit something other than the
 * staged changes the message describes.
 */
const FORBIDDEN_PASSTHROUGH = new Map<string, string>([
  ["-m", "ccli supplies the message"],
  ["--message", "ccli supplies the message"],
  ["-F", "ccli supplies the message"],
  ["--file", "ccli supplies the message"],
  ["-C", "ccli supplies the message"],
  ["--reuse-message", "ccli supplies the message"],
  ["-c", "ccli supplies the message"],
  ["--reedit-message", "ccli supplies the message"],
  ["--fixup", "ccli supplies the message"],
  ["--squash", "ccli supplies the message"],
  ["-t", "ccli supplies the message"],
  ["--template", "ccli supplies the message"],
  ["-e", "use the Edit action instead"],
  ["--edit", "use the Edit action instead"],
  ["--cleanup", "ccli controls message cleanup"],
  ["-a", "the message describes staged changes only; use ccli's --all flag to stage first"],
  ["--all", "the message describes staged changes only; use ccli's --all flag to stage first"],
  ["-i", "the message describes staged changes only"],
  ["--include", "the message describes staged changes only"],
  ["-o", "the message describes staged changes only"],
  ["--only", "the message describes staged changes only"],
  ["-p", "the message describes staged changes only"],
  ["--patch", "the message describes staged changes only"],
  ["--interactive", "the message describes staged changes only"],
  ["--pathspec-from-file", "the message describes staged changes only"],
  ["--dry-run", "ccli would report a commit that was never made"],
]);

/** Options whose value may follow as a separate argument. */
const VALUE_OPTIONS = new Set(["--author", "--date", "--trailer"]);

export function validatePassthrough(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      const previous = args[i - 1];
      if (previous !== undefined && VALUE_OPTIONS.has(previous)) continue;
      throw new CliError(
        `Unexpected git argument "${arg}". Paths are not allowed: the message describes the staged changes.`,
        {
          exitCode: ExitCode.Usage,
          hint: "Pass option values with '=', for example --author='Name <email>'.",
        },
      );
    }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const shortWithValue = /^-[mFCct]./.test(arg) ? arg.slice(0, 2) : undefined;
    const reason = FORBIDDEN_PASSTHROUGH.get(shortWithValue ?? flag);
    if (reason) {
      throw new CliError(`The git option "${flag}" cannot be passed through: ${reason}.`, {
        exitCode: ExitCode.Usage,
      });
    }
  }
}

export interface CommitResult {
  ok: boolean;
  exitCode: number;
  /** "abc1234 feat: subject" after a successful commit. */
  summary?: string;
  savedMessagePath?: string;
}

/**
 * Commit with `git commit -F <file>`. Hooks run and signing follows the user's git config.
 * The message file lives in a private temporary directory that is always removed.
 */
export async function commitWithMessage(
  repo: RepoInfo,
  message: string,
  passthrough: string[] = [],
): Promise<CommitResult> {
  validatePassthrough(passthrough);
  const dir = mkdtempSync(join(tmpdir(), "ccli-"));
  const file = join(dir, "COMMIT_MSG");
  try {
    writeFileSync(file, ensureTrailingNewline(message), { encoding: "utf8", mode: 0o600 });
    // --cleanup=whitespace keeps lines that start with "#" (for example "#123" in a body);
    // --quiet because ccli prints its own summary (hook output still shows).
    const exitCode = await gitInteractive(
      ["commit", "--quiet", "--cleanup=whitespace", "-F", file, ...passthrough],
      repo.root,
    );
    if (exitCode !== 0) {
      return { ok: false, exitCode, savedMessagePath: saveLastMessage(repo, message) };
    }
    clearLastMessage(repo);
    const head = await git(["log", "-1", "--format=%h %s"], { cwd: repo.root, allowFailure: true });
    return { ok: true, exitCode: 0, summary: head.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function lastMessagePath(repo: RepoInfo): string {
  return join(repo.gitDir, LAST_MESSAGE_FILE);
}

export function saveLastMessage(repo: RepoInfo, message: string): string {
  const path = lastMessagePath(repo);
  writeFileSync(path, ensureTrailingNewline(message), "utf8");
  return path;
}

export function loadLastMessage(repo: RepoInfo): string | null {
  try {
    const text = readFileSync(lastMessagePath(repo), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export function clearLastMessage(repo: RepoInfo): void {
  rmSync(lastMessagePath(repo), { force: true });
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
