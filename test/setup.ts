import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every test run from the developer's machine: no global git config, no real
// provider keys, no keychain, and a throwaway ccli config directory.
const sandbox = mkdtempSync(join(tmpdir(), "ccli-vitest-"));
const globalGitConfig = join(sandbox, "gitconfig");
writeFileSync(globalGitConfig, "");

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = globalGitConfig;
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.CCLI_CONFIG_DIR = join(sandbox, "config");
process.env.CCLI_CACHE_DIR = join(sandbox, "cache");
process.env.CCLI_DISABLE_KEYCHAIN = "1";
process.env.NO_COLOR = "1";
for (const name of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CCLI_DEBUG",
]) {
  delete process.env[name];
}
