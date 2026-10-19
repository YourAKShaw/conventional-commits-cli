import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  root: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  commitAll(message: string): void;
  cleanup(): void;
}

/** A throwaway git repository with deterministic identity and no global hooks or config. */
export function createRepo(options: { initialCommit?: boolean } = {}): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "ccli-test-"));
  const env = isolatedGitEnv(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "Tester");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  const repo: TempRepo = {
    root,
    git,
    write(path, content) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    commitAll(message) {
      git("add", "-A");
      git("commit", "-q", "--no-verify", "-m", message);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  if (options.initialCommit !== false) {
    repo.write("README.md", "# test\n");
    repo.commitAll("chore: initial commit");
  }
  return repo;
}

/** Environment that ignores the developer's global/system git config. */
export function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".git-global-config-does-not-exist"),
    GIT_TERMINAL_PROMPT: "0",
  };
}
