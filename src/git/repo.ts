import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "../errors.js";
import { git } from "./git.js";

export type RepoOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface RepoInfo {
  /** Absolute path of the working-tree root. */
  root: string;
  /** Absolute path of this worktree's git directory. */
  gitDir: string;
  /** Current branch name, or null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** True before the first commit on the current branch. */
  unborn: boolean;
  operation: RepoOperation | null;
}

export async function getRepo(cwd: string): Promise<RepoInfo> {
  const top = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], {
    cwd,
    allowFailure: true,
  });
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) {
      throw new CliError("This directory is not inside a git repository.", {
        hint: "Run the command from a repository, or pass --cwd <path>.",
      });
    }
    if (/must be run in a work tree/i.test(top.stderr)) {
      throw new CliError("This is a bare repository; there is no working tree to commit from.");
    }
    throw new CliError(`Could not inspect the repository: ${top.stderr.trim()}`);
  }
  const [rootLine, gitDirLine] = top.stdout.split(/\r?\n/);
  if (!rootLine || !gitDirLine) throw new CliError("Unexpected output from git rev-parse.");
  const root = resolve(rootLine);
  const gitDir = resolve(gitDirLine);

  const symbolic = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
    allowFailure: true,
  });
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() : null;
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: root,
    allowFailure: true,
  });
  const unborn = head.code !== 0 && branch !== null;

  return {
    root,
    gitDir,
    branch,
    detached: branch === null,
    unborn,
    operation: detectOperation(gitDir),
  };
}

export function detectOperation(gitDir: string): RepoOperation | null {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

/** Recent commit subjects, newest first. Empty for an unborn branch. */
export async function recentSubjects(repo: RepoInfo, count: number): Promise<string[]> {
  if (repo.unborn || count <= 0) return [];
  const log = await git(["log", `-n${count}`, "--no-merges", "--format=%s"], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (log.code !== 0) return [];
  return log.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function gitVersion(cwd: string): Promise<string | null> {
  try {
    const out = await git(["--version"], { cwd, allowFailure: true });
    return out.code === 0 ? out.stdout.trim().replace(/^git version\s*/, "") : null;
  } catch {
    return null;
  }
}
