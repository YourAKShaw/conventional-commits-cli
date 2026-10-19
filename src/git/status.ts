import { git, splitNul } from "./git.js";
import type { RepoInfo } from "./repo.js";

export interface StatusEntry {
  path: string;
  /** Original path for renames and copies. */
  origPath?: string;
  /** Index (staged) status letter, "." when unchanged. */
  index: string;
  /** Working-tree status letter, "." when unchanged. */
  worktree: string;
}

export interface RepoStatus {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  unmerged: string[];
}

export async function getStatus(repo: RepoInfo): Promise<RepoStatus> {
  const out = await git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    cwd: repo.root,
  });
  return parsePorcelainV2(out.stdout);
}

/**
 * Parse `git status --porcelain=v2 -z`. Record formats:
 *   1 XY sub mH mI mW hH hI path
 *   2 XY sub mH mI mW hH hI Xscore path\0origPath
 *   u XY sub m1 m2 m3 mW h1 h2 h3 path
 *   ? path
 */
export function parsePorcelainV2(text: string): RepoStatus {
  const fields = splitNul(text);
  const status: RepoStatus = { staged: [], unstaged: [], untracked: [], unmerged: [] };

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? "";
    const kind = record[0];
    if (kind === "1" || kind === "2") {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const pathStart = kind === "1" ? 8 : 9;
      const path = parts.slice(pathStart).join(" ");
      const entry: StatusEntry = { path, index: xy[0] ?? ".", worktree: xy[1] ?? "." };
      if (kind === "2") {
        i += 1;
        entry.origPath = fields[i] ?? "";
      }
      if (entry.index !== ".") status.staged.push(entry);
      if (entry.worktree !== ".") status.unstaged.push(entry);
    } else if (kind === "u") {
      status.unmerged.push(record.split(" ").slice(10).join(" "));
    } else if (kind === "?") {
      status.untracked.push(record.slice(2));
    }
  }
  return status;
}
