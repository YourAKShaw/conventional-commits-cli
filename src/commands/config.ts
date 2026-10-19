import { existsSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import { cacheDir, credentialsPath, globalConfigPath } from "../config/paths.js";
import {
  getPath,
  parseValue,
  readRawConfig,
  setPath,
  updateGlobalConfig,
} from "../config/write.js";
import { CliError, ExitCode } from "../errors.js";
import { getRepo } from "../git/repo.js";
import { createKeyStore } from "../keys/resolve.js";
import { REPO_CONFIG_FILE } from "../meta.js";
import { EFFORT_SCALE } from "../providers/effort.js";
import { PROVIDERS } from "../providers/registry.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { writeOut } from "../term.js";
import { authSet } from "./auth.js";
import type { CommandContext } from "./context.js";

async function repoRootOrNull(cwd: string): Promise<string | null> {
  try {
    return (await getRepo(cwd)).root;
  } catch {
    return null;
  }
}

export async function configPath(ctx: CommandContext): Promise<number> {
  const root = await repoRootOrNull(ctx.cwd);
  const lines = [
    `global config:   ${globalConfigPath(ctx.env)}${existsSync(globalConfigPath(ctx.env)) ? "" : " (not created yet)"}`,
    `credentials:     ${credentialsPath(ctx.env)} (only with --insecure-file-store)`,
    `cache:           ${cacheDir(ctx.env)}`,
    `repository:      ${root ? `${root}/${REPO_CONFIG_FILE}${existsSync(`${root}/${REPO_CONFIG_FILE}`) ? "" : " (none)"}` : "(not in a git repository)"}`,
  ];
  await writeOut(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}

export async function configShow(ctx: CommandContext): Promise<number> {
  const root = await repoRootOrNull(ctx.cwd);
  const loaded = loadConfig(root, ctx.env);
  const output = {
    sources: {
      global: existsSync(loaded.globalPath) ? loaded.globalPath : null,
      repository: loaded.repoPath,
    },
    effective: loaded.effective,
  };
  await writeOut(`${JSON.stringify(output, null, 2)}\n`);
  return ExitCode.Ok;
}

export async function configGet(ctx: CommandContext, key: string): Promise<number> {
  const root = await repoRootOrNull(ctx.cwd);
  const effective = loadConfig(root, ctx.env).effective as unknown as Record<string, unknown>;
  const raw = readRawConfig(globalConfigPath(ctx.env));
  const value =
    getPath(raw, key) ?? getPath(effective, key) ?? getPath(effective, effectiveAlias(key));
  if (value === undefined)
    throw new CliError(`Unknown or unset key "${key}".`, { exitCode: ExitCode.Usage });
  await writeOut(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  return ExitCode.Ok;
}

/** providers.openai.model in the file lives at providers.settings.openai.model in the effective config. */
function effectiveAlias(key: string): string {
  const m = /^providers\.(openai|anthropic|xai|gemini)\.(.+)$/.exec(key);
  return m ? `providers.settings.${m[1]}.${m[2]}` : key;
}

export async function configSet(ctx: CommandContext, key: string, value: string): Promise<number> {
  const path = globalConfigPath(ctx.env);
  updateGlobalConfig(path, (cfg) => setPath(cfg, key, parseValue(key, value)));
  ctx.ui.success(`Set ${key} in ${path}`);
  return ExitCode.Ok;
}

export async function configUnset(ctx: CommandContext, key: string): Promise<number> {
  const path = globalConfigPath(ctx.env);
  updateGlobalConfig(path, (cfg) => setPath(cfg, key, undefined));
  ctx.ui.success(`Removed ${key} from ${path}`);
  return ExitCode.Ok;
}

/** Guided setup: providers and fallback order, model and effort per provider, keys, gitmoji. */
export async function configInit(ctx: CommandContext): Promise<number> {
  const { ui } = ctx;
  if (!ui.interactive)
    throw new CliError("`ccli config init` needs a terminal.", { exitCode: ExitCode.Usage });
  ui.intro("Set up conventional-commits-cli");
  const store = createKeyStore(ctx.env);

  const keyStatus = new Map<ProviderId, string | null>();
  for (const id of PROVIDER_IDS) keyStatus.set(id, (await store.resolve(id))?.origin ?? null);

  const chosen = await ui.multiselect<ProviderId>({
    message: "Which AI providers do you want to use for smart commits?",
    required: true,
    initialValues: PROVIDER_IDS.filter((id) => keyStatus.get(id)),
    choices: PROVIDER_IDS.map((id) => ({
      value: id,
      label: PROVIDERS[id].displayName,
      hint: keyStatus.get(id) ? `key found in ${keyStatus.get(id)}` : "no key yet",
    })),
  });

  let order: ProviderId[] = chosen;
  if (chosen.length > 1) {
    const primary = await ui.select<ProviderId>({
      message:
        "Primary provider (the others are fallbacks when it is out of credits or unavailable)",
      choices: chosen.map((id) => ({ value: id, label: PROVIDERS[id].displayName })),
    });
    order = [primary, ...chosen.filter((id) => id !== primary)];
  }

  const providerSettings: Record<string, { model: string; effort: string }> = {};
  for (const id of order) {
    const info = PROVIDERS[id];
    const CUSTOM = "\u0000custom";
    let model = await ui.select<string>({
      message: `${info.displayName} model`,
      choices: [
        ...info.models.map((m) => ({
          value: m.id,
          label: m.id,
          ...(m.id === info.defaultModel
            ? { hint: "recommended for commit messages" }
            : m.note
              ? { hint: m.note }
              : {}),
        })),
        { value: CUSTOM, label: "Other model ID…" },
      ],
      initialValue: info.defaultModel,
    });
    if (model === CUSTOM) {
      model = (
        await ui.text({
          message: "Model ID",
          validate: (v) => (v.trim() ? undefined : "Enter a model ID."),
        })
      ).trim();
    }
    const known = info.models.find((m) => m.id === model)?.efforts;
    const efforts = known ?? EFFORT_SCALE.filter((e) => e !== "none");
    const effort = await ui.select<string>({
      message: `${info.displayName} reasoning effort (${info.effortParameter})`,
      choices: [
        { value: "auto", label: "auto", hint: "provider default" },
        ...efforts.map((e) => ({
          value: e,
          label: e,
          ...(e === info.defaultEffort ? { hint: "recommended" } : {}),
        })),
      ],
      initialValue: efforts.includes(info.defaultEffort) ? info.defaultEffort : "auto",
    });
    providerSettings[id] = { model, effort };
  }

  const gitmoji = await ui.confirm({
    message: "Add a gitmoji to commit headers (e.g. feat: ✨ add login)?",
    initialValue: true,
  });

  const path = globalConfigPath(ctx.env);
  updateGlobalConfig(path, (cfg) => {
    setPath(cfg, "providers.order", order);
    for (const [id, s] of Object.entries(providerSettings)) {
      setPath(cfg, `providers.${id}.model`, s.model);
      setPath(cfg, `providers.${id}.effort`, s.effort);
    }
    setPath(cfg, "format.gitmoji.enabled", gitmoji);
  });
  ui.success(`Saved ${path}`);

  for (const id of order) {
    if (keyStatus.get(id)) continue;
    const add = await ui.confirm({
      message: `Store a ${PROVIDERS[id].displayName} API key now?`,
      initialValue: true,
    });
    if (add) {
      try {
        await authSet(ctx, id, {});
      } catch (error) {
        if (error instanceof CliError && /keychain is not available/.test(error.message)) {
          ui.warn(`${error.message} ${error.hint ?? ""}`);
        } else throw error;
      }
    } else {
      ui.info(`Set ${PROVIDERS[id].envVars[0]} later, or run \`ccli auth set ${id}\`.`);
    }
  }
  ui.outro("Ready. Stage your changes and run `ccli smart commit`.");
  return ExitCode.Ok;
}
