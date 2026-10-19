import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CliError, ExitCode } from "../errors.js";
import { git } from "../git/git.js";
import { getRepo } from "../git/repo.js";
import { writeOut } from "../term.js";
import type { CommandContext } from "./context.js";

export const HOOK_MARKER = "# managed-by: conventional-commits-cli";

/**
 * prepare-commit-msg hook: on a plain `git commit` (no -m/-F/template/merge/amend), fill the
 * empty message with a smart-mode suggestion. Git then opens the editor, so saving the message
 * is the approval. Any failure leaves git's default behaviour untouched.
 */
export const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
# Suggests a Conventional Commit message for plain \`git commit\`. Remove with: ccli hook uninstall
case "$2" in
  "") ;;
  *) exit 0 ;;
esac
command -v ccli >/dev/null 2>&1 || exit 0
ccli smart commit --hook "$1" </dev/null >/dev/null || true
exit 0
`;

async function hookPath(ctx: CommandContext): Promise<{ path: string; root: string }> {
  const repo = await getRepo(ctx.cwd);
  const out = await git(["rev-parse", "--git-path", "hooks/prepare-commit-msg"], {
    cwd: repo.root,
  });
  const rel = out.stdout.trim();
  return { path: isAbsolute(rel) ? rel : join(repo.root, rel), root: repo.root };
}

export async function hookInstall(ctx: CommandContext): Promise<number> {
  const { path } = await hookPath(ctx);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current.includes(HOOK_MARKER)) {
      ctx.ui.info(`The hook is already installed at ${path}.`);
      return ExitCode.Ok;
    }
    throw new CliError(
      `A different prepare-commit-msg hook already exists at ${path}; it was left untouched.`,
      {
        hint: 'Add this line to it instead:  ccli smart commit --hook "$1" </dev/null >/dev/null || true',
      },
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, HOOK_SCRIPT, "utf8");
  chmodSync(path, 0o755);
  ctx.ui.success(`Installed ${path}`);
  ctx.ui.info(
    "Run `git commit` without -m: the editor opens with a suggested message. Saving it commits; an empty message aborts.",
  );
  ctx.ui.info(
    "The hook only uses providers you have already approved by running `ccli smart commit` once in a terminal.",
  );
  return ExitCode.Ok;
}

export async function hookUninstall(ctx: CommandContext): Promise<number> {
  const { path } = await hookPath(ctx);
  if (!existsSync(path)) {
    ctx.ui.info("No prepare-commit-msg hook is installed.");
    return ExitCode.Ok;
  }
  if (!readFileSync(path, "utf8").includes(HOOK_MARKER)) {
    throw new CliError(`${path} was not installed by ccli; it was left untouched.`);
  }
  rmSync(path);
  ctx.ui.success(`Removed ${path}`);
  return ExitCode.Ok;
}

export async function hookStatus(ctx: CommandContext): Promise<number> {
  const { path } = await hookPath(ctx);
  const state = !existsSync(path)
    ? "not installed"
    : readFileSync(path, "utf8").includes(HOOK_MARKER)
      ? "installed"
      : "another prepare-commit-msg hook exists";
  await writeOut(`${state}: ${path}\n`);
  return ExitCode.Ok;
}
