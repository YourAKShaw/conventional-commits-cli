import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { z } from "zod";
import { CliError } from "../errors.js";
import { DEFAULT_DENY_GLOBS, readIgnoreFile } from "../guard/denylist.js";
import type { GitmojiPosition, GitmojiStyle, TypeInfo } from "../message/types.js";
import { REPO_CONFIG_FILE } from "../meta.js";
import { PROVIDERS } from "../providers/registry.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { globalConfigPath } from "./paths.js";
import {
  type GlobalConfig,
  globalConfigSchema,
  REPO_FORBIDDEN_KEYS,
  type RepoConfig,
  repoConfigSchema,
} from "./schema.js";

export interface ResolvedProviderSettings {
  model: string;
  effort: string;
  maxOutputTokens: number;
  timeoutMs: number;
  baseUrl: string | null;
  enabled: boolean;
  structuredOutput: boolean;
}

export interface EffectiveConfig {
  providers: {
    order: ProviderId[];
    /** Set when the repository restricts providers. */
    allow: ProviderId[] | null;
    settings: Record<ProviderId, ResolvedProviderSettings>;
  };
  smart: {
    enabled: boolean;
    disabledByRepo: boolean;
    maxInputTokens: number;
    maxRegenerations: number;
    requestBudgetMs: number;
    language: string;
    historyCount: number;
    largeChangeFiles: number;
    largeChangeLines: number;
    acknowledgedProviders: ProviderId[];
  };
  format: {
    gitmoji: { enabled: boolean; style: GitmojiStyle; position: GitmojiPosition };
    headerMaxLength: number;
    bodyWrap: number;
    types: "commitlint" | TypeInfo[];
    scopes: string[];
  };
  secrets: {
    denyGlobs: string[];
    extraPatterns: string[];
    onDetect: "ask" | "exclude" | "redact" | "abort";
  };
  commitlint: { loadJsConfig: boolean };
}

export interface LoadedConfig {
  effective: EffectiveConfig;
  globalPath: string;
  global: GlobalConfig | null;
  repoPath: string | null;
  repo: RepoConfig | null;
}

export const DEFAULTS = {
  order: ["openai", "anthropic", "xai", "gemini"] as ProviderId[],
  maxOutputTokens: 4096,
  timeoutMs: 45_000,
  maxInputTokens: 12_000,
  maxRegenerations: 5,
  requestBudgetMs: 90_000,
  language: "English",
  historyCount: 15,
  largeChangeFiles: 100,
  largeChangeLines: 2000,
  headerMaxLength: 72,
  bodyWrap: 72,
} as const;

export function loadConfig(
  repoRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const globalPath = globalConfigPath(env);
  const global = readGlobalConfig(globalPath);
  const repoPath = repoRoot ? join(repoRoot, REPO_CONFIG_FILE) : null;
  const repo = repoPath && existsSync(repoPath) ? readRepoConfig(repoPath) : null;
  const ignoreGlobs = repoRoot ? readIgnoreFile(repoRoot) : [];
  return {
    effective: resolveConfig(global ?? {}, repo ?? {}, ignoreGlobs),
    globalPath,
    global,
    repoPath: repo ? repoPath : null,
    repo,
  };
}

export function resolveConfig(
  global: GlobalConfig,
  repo: RepoConfig,
  ignoreGlobs: string[] = [],
): EffectiveConfig {
  const settings = {} as Record<ProviderId, ResolvedProviderSettings>;
  for (const id of PROVIDER_IDS) {
    const s = global.providers?.[id] ?? {};
    settings[id] = {
      model: s.model ?? PROVIDERS[id].defaultModel,
      effort: s.effort ?? PROVIDERS[id].defaultEffort,
      maxOutputTokens: s.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
      timeoutMs: s.timeoutMs ?? DEFAULTS.timeoutMs,
      baseUrl: s.baseUrl ?? null,
      enabled: s.enabled ?? true,
      structuredOutput: s.structuredOutput ?? true,
    };
  }

  const order = dedupe(global.providers?.order ?? DEFAULTS.order);
  const allow = repo.providers?.allow ? dedupe(repo.providers.allow) : null;

  const format = { ...global.format, ...repo.format };
  const gitmoji = { ...global.format?.gitmoji, ...repo.format?.gitmoji };
  const types = format.types;

  const globalSmart = global.smart ?? {};
  const disabledByRepo = repo.smart?.enabled === false;

  return {
    providers: { order, allow, settings },
    smart: {
      enabled: (globalSmart.enabled ?? true) && !disabledByRepo,
      disabledByRepo,
      maxInputTokens: Math.min(
        globalSmart.maxInputTokens ?? DEFAULTS.maxInputTokens,
        repo.smart?.maxInputTokens ?? Number.POSITIVE_INFINITY,
      ),
      maxRegenerations: globalSmart.maxRegenerations ?? DEFAULTS.maxRegenerations,
      requestBudgetMs: globalSmart.requestBudgetMs ?? DEFAULTS.requestBudgetMs,
      language: globalSmart.language ?? DEFAULTS.language,
      historyCount: globalSmart.historyCount ?? DEFAULTS.historyCount,
      largeChangeFiles: globalSmart.largeChangeFiles ?? DEFAULTS.largeChangeFiles,
      largeChangeLines: globalSmart.largeChangeLines ?? DEFAULTS.largeChangeLines,
      acknowledgedProviders: dedupe(globalSmart.acknowledgedProviders ?? []),
    },
    format: {
      gitmoji: {
        enabled: gitmoji.enabled ?? true,
        style: gitmoji.style ?? "unicode",
        position: gitmoji.position ?? "after-colon",
      },
      headerMaxLength: format.headerMaxLength ?? DEFAULTS.headerMaxLength,
      bodyWrap: format.bodyWrap ?? DEFAULTS.bodyWrap,
      types:
        types === undefined || types === "commitlint"
          ? "commitlint"
          : types.map((t) => (typeof t === "string" ? { type: t, description: "" } : t)),
      scopes: dedupe([...(format.scopes ?? [])]),
    },
    secrets: {
      denyGlobs: dedupe([
        ...(global.secrets?.extraDenyGlobs ?? []),
        ...(repo.secrets?.extraDenyGlobs ?? []),
        ...ignoreGlobs,
      ]),
      extraPatterns: dedupe([
        ...(global.secrets?.extraPatterns ?? []),
        ...(repo.secrets?.extraPatterns ?? []),
      ]),
      onDetect: global.secrets?.onDetect ?? "ask",
    },
    commitlint: { loadJsConfig: global.commitlint?.loadJsConfig ?? false },
  };
}

/** All deny globs in effect (defaults plus user and repository additions). */
export function allDenyGlobs(config: EffectiveConfig): string[] {
  return [...DEFAULT_DENY_GLOBS, ...config.secrets.denyGlobs];
}

export function readGlobalConfig(path: string): GlobalConfig | null {
  if (!existsSync(path)) return null;
  const json = readJson(path);
  const result = globalConfigSchema.safeParse(json);
  if (!result.success) {
    throw new CliError(`Invalid configuration in ${path}:\n${z.prettifyError(result.error)}`, {
      hint: "Fix the file, or run `ccli config init` to recreate it.",
    });
  }
  return result.data;
}

export function readRepoConfig(path: string): RepoConfig {
  const json = readJson(path);
  if (json && typeof json === "object") {
    for (const [key, what] of Object.entries(REPO_FORBIDDEN_KEYS)) {
      if (hasPath(json, key)) {
        throw new CliError(
          `${path} sets "${key}", but a repository config cannot control ${what}. A cloned repository is not trusted to redirect your diffs.`,
          { hint: "Move this setting to your global config (see `ccli config path`)." },
        );
      }
    }
  }
  const result = repoConfigSchema.safeParse(json);
  if (!result.success) {
    throw new CliError(
      `Invalid repository configuration in ${path}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function hasPath(obj: unknown, dotted: string): boolean {
  let current: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || !(part in (current as object))) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
