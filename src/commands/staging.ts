import { CliError } from "../errors.js";
import { type StageChoice, stage } from "../git/staging.js";
import { getStatus, type RepoStatus } from "../git/status.js";
import { c } from "../term.js";
import type { RepoContext } from "./context.js";

export interface StagingResult {
  status: RepoStatus;
  /** Paths ccli staged; unstaged again if the user cancels. */
  stagedByUs: string[];
}

/**
 * Make sure there is something staged. Staging is always the user's choice: interactively
 * they pick tracked / all / specific files; non-interactively only an explicit --all stages.
 */
export async function ensureStaged(
  ctx: RepoContext,
  options: { stageAll?: boolean; allowEmpty?: boolean } = {},
): Promise<StagingResult> {
  let status = await getStatus(ctx.repo);
  if (status.unmerged.length > 0) {
    throw new CliError(
      `Resolve merge conflicts first (${status.unmerged.length} unmerged path(s)).`,
    );
  }
  if (status.staged.length > 0 || options.allowEmpty) return { status, stagedByUs: [] };

  const tracked = status.unstaged.length;
  const untracked = status.untracked.length;
  if (tracked === 0 && untracked === 0) {
    throw new CliError("Nothing to commit: the working tree is clean.");
  }

  let choice: StageChoice;
  if (options.stageAll) {
    if (tracked === 0) {
      throw new CliError("--all stages modified tracked files, but only untracked files changed.", {
        hint: "Stage them with `git add <path>` first.",
      });
    }
    choice = "tracked";
  } else if (!ctx.ui.interactive) {
    throw new CliError("Nothing is staged.", {
      hint: "Stage changes with `git add`, or pass --all to stage tracked changes.",
    });
  } else {
    const picked = await ctx.ui.select<"tracked" | "all" | "pick">({
      message: "Nothing is staged yet. What should be included?",
      choices: [
        ...(tracked > 0
          ? [
              {
                value: "tracked" as const,
                label: `All tracked changes (${tracked} file${tracked === 1 ? "" : "s"})`,
                hint: "git add -u",
              },
            ]
          : []),
        ...(untracked > 0
          ? [
              {
                value: "all" as const,
                label: `Everything, including ${untracked} untracked file${untracked === 1 ? "" : "s"}`,
                hint: "git add -A",
              },
            ]
          : []),
        { value: "pick" as const, label: "Choose files…" },
      ],
    });
    if (picked === "pick") {
      const paths = await ctx.ui.multiselect<string>({
        message: "Select files to stage",
        required: true,
        choices: [
          ...status.unstaged.map((e) => ({
            value: e.path,
            label: e.path,
            hint: describeWorktree(e.worktree),
          })),
          ...status.untracked.map((p) => ({ value: p, label: p, hint: "untracked" })),
        ],
      });
      choice = { paths };
    } else {
      choice = picked;
    }
  }

  const stagedByUs = await stage(ctx.repo, status, choice);
  status = await getStatus(ctx.repo);
  ctx.ui.step(`Staged ${stagedByUs.length} path${stagedByUs.length === 1 ? "" : "s"}.`);
  return { status, stagedByUs };
}

export function reportNotIncluded(ctx: RepoContext, status: RepoStatus): void {
  const stagedPaths = new Set(status.staged.map((e) => e.path));
  const unstagedOnly = status.unstaged.filter((e) => !stagedPaths.has(e.path)).length;
  const partly = status.unstaged.filter((e) => stagedPaths.has(e.path)).length;
  const parts: string[] = [];
  if (unstagedOnly)
    parts.push(`${unstagedOnly} modified file${unstagedOnly === 1 ? "" : "s"} not staged`);
  if (partly) parts.push(`${partly} partly staged file${partly === 1 ? "" : "s"}`);
  if (status.untracked.length)
    parts.push(
      `${status.untracked.length} untracked file${status.untracked.length === 1 ? "" : "s"}`,
    );
  if (parts.length)
    ctx.ui.info(
      `${c.dim("Not included:")} ${parts.join(", ")}. Only staged changes are committed.`,
    );
}

function describeWorktree(code: string): string {
  switch (code) {
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "type changed";
    default:
      return "changed";
  }
}
