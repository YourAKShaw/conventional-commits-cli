import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { debug } from "../term.js";
import { stripLeadingGitmoji } from "./parse.js";
import type { Issue } from "./spec.js";
import type { TypeInfo } from "./types.js";

/** commitlint rule tuple: [level 0|1|2, "always"|"never", value?]. */
export type RuleConfig = [0 | 1 | 2, "always" | "never"] | [0 | 1 | 2, "always" | "never", unknown];
export type Rules = Record<string, RuleConfig>;

export interface LintConfig {
  rules: Rules;
  parserOpts: Record<string, unknown>;
  /** Where the effective rules came from, for `ccli doctor` and notes. */
  source: "conventional-defaults" | "repo-json" | "repo-js";
  sourcePath: string | null;
  notes: string[];
  typeDescriptions: Record<string, string>;
}

export interface LintConfigOptions {
  /** Explicit type list from ccli config, or "commitlint" to use the rules' type-enum. */
  types: "commitlint" | TypeInfo[];
  headerMaxLength: number;
  /** Execute JavaScript/TypeScript/YAML commitlint configs via the repository's own @commitlint/load. */
  loadJsConfig: boolean;
}

const JSON_CONFIGS = [".commitlintrc", ".commitlintrc.json"];
const EXECUTABLE_CONFIGS = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
  "commitlint.config.mts",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  ".commitlintrc.mts",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
];

const CONVENTIONAL_EXTENDS = new Set([
  "@commitlint/config-conventional",
  "conventional",
  "@commitlint/conventional",
]);

let conventionalCache: Promise<{
  rules: Rules;
  parserOpts: Record<string, unknown>;
  types: Record<string, string>;
}> | null = null;

async function conventionalDefaults() {
  conventionalCache ??= (async () => {
    const [{ default: config }, { default: createPreset }] = await Promise.all([
      import("@commitlint/config-conventional"),
      import("conventional-changelog-conventionalcommits"),
    ]);
    const preset = (await createPreset()) as { parser?: Record<string, unknown> };
    const typeEnum = (config.prompt?.questions?.type?.enum ?? {}) as Record<
      string,
      { description?: string }
    >;
    const types: Record<string, string> = {};
    for (const [key, value] of Object.entries(typeEnum)) types[key] = value.description ?? key;
    return {
      rules: structuredClone(config.rules) as unknown as Rules,
      parserOpts: (preset.parser ?? {}) as Record<string, unknown>,
      types,
    };
  })();
  return conventionalCache;
}

export async function loadLintConfig(
  repoRoot: string,
  options: LintConfigOptions,
): Promise<LintConfig> {
  const base = await conventionalDefaults();
  const notes: string[] = [];
  let rules: Rules = { ...base.rules };
  let parserOpts = base.parserOpts;
  let source: LintConfig["source"] = "conventional-defaults";
  let sourcePath: string | null = null;

  // ccli's own format settings apply on top of the conventional defaults.
  rules["header-max-length"] = [2, "always", options.headerMaxLength];
  if (options.types !== "commitlint") {
    rules["type-enum"] = [2, "always", options.types.map((t) => t.type)];
  }

  const declarative = findDeclarativeConfig(repoRoot);
  const executable = EXECUTABLE_CONFIGS.find((f) => existsSync(join(repoRoot, f)));

  if (declarative) {
    const { rules: repoRules, unsupportedExtends } = declarative;
    rules = { ...rules, ...repoRules };
    source = "repo-json";
    sourcePath = declarative.path;
    for (const ext of unsupportedExtends) {
      notes.push(
        `commitlint "extends: ${ext}" in ${declarative.path} is not loaded; only its own rules and the conventional preset are applied.`,
      );
    }
  } else if (executable) {
    sourcePath = join(repoRoot, executable);
    if (options.loadJsConfig) {
      const loaded = await loadWithRepoCommitlint(repoRoot);
      if (loaded) {
        rules = { ...rules, ...loaded.rules };
        if (loaded.parserOpts) parserOpts = loaded.parserOpts;
        source = "repo-js";
      } else {
        notes.push(
          `Could not load ${executable}: @commitlint/load is not installed in this repository. Using conventional defaults.`,
        );
      }
    } else {
      notes.push(
        `${executable} was found but not executed (ccli does not run repository code by default). Using conventional defaults; the repository's commit-msg hook still applies its own rules. Enable with: ccli config set commitlint.loadJsConfig true`,
      );
    }
  }

  const typeDescriptions: Record<string, string> = { ...base.types };
  if (options.types !== "commitlint") {
    for (const t of options.types) typeDescriptions[t.type] = t.description;
  }
  return { rules, parserOpts, source, sourcePath, notes, typeDescriptions };
}

/** Allowed types from the effective rules (type-enum), in rule order. */
export function allowedTypes(config: LintConfig): TypeInfo[] {
  const rule = config.rules["type-enum"];
  const list =
    rule && rule[0] > 0 && rule[1] === "always" && Array.isArray(rule[2])
      ? (rule[2] as string[])
      : null;
  const types = list ?? Object.keys(config.typeDescriptions);
  return types.map((type) => ({ type, description: config.typeDescriptions[type] ?? "" }));
}

/** Allowed scopes when the effective rules restrict them (scope-enum). */
export function allowedScopes(config: LintConfig): string[] {
  const rule = config.rules["scope-enum"];
  if (rule && rule[0] > 0 && rule[1] === "always" && Array.isArray(rule[2]))
    return rule[2] as string[];
  return [];
}

export function headerLimit(config: LintConfig, fallback: number): number {
  const rule = config.rules["header-max-length"];
  if (rule && rule[0] > 0 && typeof rule[2] === "number") return rule[2];
  return fallback;
}

export async function runCommitlint(raw: string, config: LintConfig): Promise<Issue[]> {
  const { default: lint } = await import("@commitlint/lint");
  // Prefix-position gitmoji is outside the spec; lint the header without it.
  const lines = raw.split("\n");
  lines[0] = stripLeadingGitmoji(lines[0] ?? "").text;
  const report = await lint(lines.join("\n"), config.rules as never, {
    parserOpts: config.parserOpts as never,
    defaultIgnores: true,
  });
  const issues: Issue[] = [];
  for (const e of report.errors) {
    issues.push({ level: "error", source: "commitlint", rule: e.name, message: e.message });
  }
  for (const w of report.warnings) {
    issues.push({ level: "warning", source: "commitlint", rule: w.name, message: w.message });
  }
  return issues;
}

interface DeclarativeConfig {
  path: string;
  rules: Rules;
  unsupportedExtends: string[];
}

function findDeclarativeConfig(repoRoot: string): DeclarativeConfig | null {
  for (const file of JSON_CONFIGS) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    const parsed = safeJson(readFileSync(path, "utf8"));
    if (parsed === undefined) {
      debug(`${file} is not JSON (YAML?); treating it as an executable config`);
      continue;
    }
    return toDeclarative(path, parsed);
  }
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = safeJson(readFileSync(pkgPath, "utf8")) as { commitlint?: unknown } | undefined;
    if (pkg && typeof pkg.commitlint === "object" && pkg.commitlint !== null) {
      return toDeclarative(`${pkgPath}#commitlint`, pkg.commitlint);
    }
  }
  return null;
}

function toDeclarative(path: string, value: unknown): DeclarativeConfig {
  const obj = (typeof value === "object" && value !== null ? value : {}) as {
    extends?: unknown;
    rules?: unknown;
  };
  const extendsList =
    typeof obj.extends === "string"
      ? [obj.extends]
      : Array.isArray(obj.extends)
        ? obj.extends.map(String)
        : [];
  const rules: Rules = {};
  if (obj.rules && typeof obj.rules === "object") {
    for (const [name, rule] of Object.entries(obj.rules as Record<string, unknown>)) {
      if (isRuleConfig(rule)) rules[name] = rule;
      else debug(`ignoring malformed commitlint rule ${name} in ${path}`);
    }
  }
  return {
    path,
    rules,
    unsupportedExtends: extendsList.filter((e) => !CONVENTIONAL_EXTENDS.has(e)),
  };
}

function isRuleConfig(value: unknown): value is RuleConfig {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    (value[0] === 0 || value[0] === 1 || value[0] === 2) &&
    (value[1] === "always" || value[1] === "never")
  );
}

async function loadWithRepoCommitlint(
  repoRoot: string,
): Promise<{ rules: Rules; parserOpts?: Record<string, unknown> } | null> {
  try {
    const require = createRequire(join(repoRoot, "package.json"));
    const loadPath = require.resolve("@commitlint/load");
    const mod = (await import(pathToFileURL(loadPath).href)) as {
      default?: (
        seed: object,
        options: { cwd: string },
      ) => Promise<{ rules: Rules; parserPreset?: { parserOpts?: Record<string, unknown> } }>;
    };
    if (typeof mod.default !== "function") return null;
    const loaded = await mod.default({}, { cwd: repoRoot });
    const parserOpts = loaded.parserPreset?.parserOpts;
    return parserOpts ? { rules: loaded.rules, parserOpts } : { rules: loaded.rules };
  } catch (error) {
    debug(`@commitlint/load failed: ${(error as Error).message}`);
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
