import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { type LoadedConfig, loadConfig } from "../config/load.js";
import { ExitCode, errorMessage } from "../errors.js";
import { git } from "../git/git.js";
import { getRepo, gitVersion } from "../git/repo.js";
import { compileUserPatterns } from "../guard/patterns.js";
import { createKeyStore, maskKey } from "../keys/resolve.js";
import { loadLintConfig } from "../message/commitlint.js";
import { VERSION } from "../meta.js";
import { resolveEffort } from "../providers/effort.js";
import { modelInfo, PROVIDERS } from "../providers/registry.js";
import { PROVIDER_IDS } from "../providers/types.js";
import { c, writeOut } from "../term.js";
import type { CommandContext } from "./context.js";
import { HOOK_MARKER } from "./hook.js";

type Status = "ok" | "warn" | "error" | "info";

interface Check {
  area: string;
  status: Status;
  message: string;
}

/** Environment report for setup problems and bug reports. Never prints keys or diffs. */
export async function runDoctor(ctx: CommandContext, options: { json?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const add = (area: string, status: Status, message: string) =>
    checks.push({ area, status, message });

  add("ccli", "info", `version ${VERSION}`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(
    "node",
    nodeMajor >= 22 ? "ok" : "error",
    `Node.js ${process.versions.node} on ${process.platform}/${process.arch}${nodeMajor >= 22 ? "" : " — Node.js 22.12 or newer is required"}`,
  );

  const gv = await gitVersion(ctx.cwd);
  add("git", gv ? "ok" : "error", gv ? `git ${gv}` : "git was not found on PATH");

  let repoRoot: string | null = null;
  try {
    const repo = await getRepo(ctx.cwd);
    repoRoot = repo.root;
    add(
      "repository",
      "ok",
      `${repo.root}${repo.branch ? ` (branch ${repo.branch})` : " (detached HEAD)"}${repo.operation ? ` — ${repo.operation} in progress` : ""}`,
    );
  } catch (error) {
    add("repository", "info", errorMessage(error));
  }

  let loaded: LoadedConfig | null = null;
  try {
    loaded = loadConfig(repoRoot, ctx.env);
    add(
      "config",
      "ok",
      existsSync(loaded.globalPath)
        ? `global ${loaded.globalPath}`
        : `no global config yet (${loaded.globalPath})`,
    );
    if (loaded.repoPath) add("config", "ok", `repository ${loaded.repoPath}`);
    if (loaded.effective.smart.disabledByRepo)
      add("config", "warn", "smart mode is disabled by the repository config");
    for (const e of compileUserPatterns(loaded.effective.secrets.extraPatterns).errors)
      add("secrets", "error", e);
  } catch (error) {
    add("config", "error", errorMessage(error));
  }

  if (repoRoot && loaded) {
    try {
      const lint = await loadLintConfig(repoRoot, {
        types: loaded.effective.format.types,
        headerMaxLength: loaded.effective.format.headerMaxLength,
        loadJsConfig: loaded.effective.commitlint.loadJsConfig,
      });
      add(
        "commitlint",
        "ok",
        lint.sourcePath
          ? `rules from ${lint.sourcePath} (${lint.source})`
          : "conventional defaults",
      );
      for (const note of lint.notes) add("commitlint", "info", note);
    } catch (error) {
      add("commitlint", "error", errorMessage(error));
    }
    try {
      const out = await git(["rev-parse", "--git-path", "hooks/prepare-commit-msg"], {
        cwd: repoRoot,
      });
      const rel = out.stdout.trim();
      const path = rel.startsWith("/") || /^[A-Za-z]:/.test(rel) ? rel : join(repoRoot, rel);
      const installed = existsSync(path) && readFileSync(path, "utf8").includes(HOOK_MARKER);
      add(
        "hook",
        "info",
        installed
          ? "prepare-commit-msg hook installed"
          : "prepare-commit-msg hook not installed (optional)",
      );
    } catch {
      // Hooks are optional; ignore.
    }
  }

  const store = createKeyStore(ctx.env);
  const keychain = await store.keychain.availability();
  add(
    "keychain",
    keychain.available ? "ok" : "warn",
    keychain.available ? "OS keychain available" : `OS keychain unavailable: ${keychain.reason}`,
  );
  const fileWarning = store.file.permissionWarning();
  if (fileWarning) add("keychain", "warn", fileWarning);

  if (loaded) {
    const { providers, smart } = loaded.effective;
    let ready = 0;
    for (const id of providers.order) {
      const s = providers.settings[id];
      const name = PROVIDERS[id].displayName;
      if (!s.enabled) {
        add(id, "info", `${name}: disabled`);
        continue;
      }
      if (providers.allow && !providers.allow.includes(id)) {
        add(id, "info", `${name}: not allowed by the repository config`);
        continue;
      }
      const key = await store.resolve(id);
      const info = modelInfo(id, s.model);
      const effort = resolveEffort(id, s.model, s.effort);
      const parts = [
        key
          ? `key ${maskKey(key.value)} from ${key.origin}`
          : `no key (${PROVIDERS[id].envVars[0]})`,
        `model ${s.model}${info ? "" : " (not in the built-in list; passed through)"}`,
        `effort ${effort.value ?? "provider default"}`,
        smart.acknowledgedProviders.includes(id)
          ? "approved for diffs"
          : "not yet approved for diffs",
        ...(s.baseUrl ? [`base URL ${s.baseUrl}`] : []),
      ];
      if (key) ready++;
      add(id, key ? (effort.warning ? "warn" : "ok") : "warn", `${name}: ${parts.join(" · ")}`);
      if (effort.warning) add(id, "warn", effort.warning);
    }
    for (const id of PROVIDER_IDS.filter((p) => !providers.order.includes(p))) {
      add(id, "info", `${PROVIDERS[id].displayName}: not in providers.order`);
    }
    add(
      "smart",
      ready > 0 ? "ok" : "warn",
      ready > 0
        ? `${ready} provider(s) ready, order: ${providers.order.join(" → ")}`
        : "no provider has an API key yet — run `ccli config init`",
    );
  }

  if (options.json) {
    await writeOut(`${JSON.stringify({ version: VERSION, checks }, null, 2)}\n`);
  } else {
    const icon: Record<Status, string> = {
      ok: c.green("✔"),
      warn: c.yellow("⚠"),
      error: c.red("✖"),
      info: c.blue("ℹ"),
    };
    await writeOut(
      `${checks.map((ch) => `${icon[ch.status]} ${c.dim(ch.area.padEnd(10))} ${ch.message}`).join("\n")}\n`,
    );
  }
  return checks.some((ch) => ch.status === "error") ? ExitCode.Error : ExitCode.Ok;
}
