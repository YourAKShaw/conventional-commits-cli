import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { CliError } from "../errors.js";
import { git } from "../git/git.js";
import type { RepoInfo } from "../git/repo.js";

export const SCISSORS = "# ------------------------ >8 ------------------------";

/**
 * Open `message` in the user's git editor (GIT_EDITOR, core.editor, VISUAL, EDITOR — resolved
 * by `git var GIT_EDITOR`) and return the edited text. Everything from the scissors line down
 * is help text and is removed, so lines starting with "#" in the message itself survive.
 */
export async function editInGitEditor(
  repo: RepoInfo,
  message: string,
  help: string[] = [],
): Promise<string> {
  const editorOut = await git(["var", "GIT_EDITOR"], { cwd: repo.root, allowFailure: true });
  const editor = editorOut.stdout.trim();
  if (editorOut.code !== 0 || !editor) {
    throw new CliError("No editor is configured.", {
      hint: "Set one with: git config --global core.editor <command>",
    });
  }

  const file = join(repo.gitDir, "CCLI_EDITMSG");
  const helpBlock = [
    SCISSORS,
    "# Do not modify or remove the line above.",
    "# Everything below it will be ignored.",
    "# Save and close the editor to continue; an empty message cancels the edit.",
    ...help.map((h) => `# ${h}`),
  ];
  writeFileSync(file, `${message.trimEnd()}\n\n${helpBlock.join("\n")}\n`, "utf8");

  const code = await runEditor(editor, file, repo.root);
  if (code !== 0)
    throw new CliError(`The editor exited with code ${code}; the message was not changed.`);
  return stripHelp(readFileSync(file, "utf8"));
}

export function stripHelp(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const cut = normalized.indexOf(SCISSORS);
  const kept = cut === -1 ? normalized : normalized.slice(0, cut);
  return kept.replace(/[ \t]+$/gm, "").trim();
}

/** Run the editor the way git does: `sh -c '<editor> "$@"' <editor> <file>`. */
function runEditor(editor: string, file: string, cwd: string): Promise<number> {
  const shell = process.platform === "win32" ? findGitShell() : "/bin/sh";
  return new Promise((resolve, reject) => {
    const child = shell
      ? spawn(shell, ["-c", `${editor} "$@"`, editor, file], { cwd, stdio: "inherit" })
      : spawn(`${editor} "${file}"`, { cwd, stdio: "inherit", shell: true });
    child.on("error", (error) =>
      reject(new CliError(`Could not start the editor "${editor}": ${error.message}`)),
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Git for Windows ships sh.exe; using it keeps editor strings quoted for sh working. */
export function findGitShell(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!dir) continue;
    if (existsSync(join(dir, "git.exe"))) {
      // ...\Git\cmd\git.exe or ...\Git\bin\git.exe or ...\Git\mingw64\bin\git.exe
      let root = dirname(dir);
      if (root.toLowerCase().endsWith("mingw64")) root = dirname(root);
      candidates.push(join(root, "bin", "sh.exe"), join(root, "usr", "bin", "sh.exe"));
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}
