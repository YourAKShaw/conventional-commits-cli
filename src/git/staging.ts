import { git } from "./git.js";
import type { RepoInfo } from "./repo.js";
import type { RepoStatus } from "./status.js";

export type StageChoice = "tracked" | "all" | { paths: string[] };

/**
 * Stage changes on the user's behalf and return exactly the paths that were staged,
 * so the operation can be undone if the user cancels.
 */
export async function stage(
  repo: RepoInfo,
  status: RepoStatus,
  choice: StageChoice,
): Promise<string[]> {
  let paths: string[];
  if (choice === "tracked") {
    paths = unique(status.unstaged.map((e) => e.path));
  } else if (choice === "all") {
    paths = unique([...status.unstaged.map((e) => e.path), ...status.untracked]);
  } else {
    paths = unique(choice.paths);
  }
  if (paths.length === 0) return [];
  // --pathspec-from-file avoids command-line length limits (notably on Windows).
  await git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: repo.root,
    input: `${paths.join("\0")}\0`,
  });
  return paths;
}

/** Undo `stage()` by resetting those paths in the index to HEAD (or removing them before the first commit). */
export async function unstage(repo: RepoInfo, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const input = `${paths.join("\0")}\0`;
  if (repo.unborn) {
    await git(
      [
        "rm",
        "--cached",
        "-r",
        "-q",
        "--ignore-unmatch",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { cwd: repo.root, input },
    );
    return;
  }
  await git(["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: repo.root,
    input,
    allowFailure: true,
  });
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
