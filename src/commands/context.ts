import { type EffectiveConfig, type LoadedConfig, loadConfig } from "../config/load.js";
import { CliError } from "../errors.js";
import { getRepo, type RepoInfo, recentSubjects } from "../git/repo.js";
import {
  allowedScopes,
  allowedTypes,
  headerLimit,
  type LintConfig,
  loadLintConfig,
} from "../message/commitlint.js";
import { parseHeader } from "../message/parse.js";
import type { FormatSettings, TypeInfo } from "../message/types.js";
import type { CommandContext } from "./base.js";

export type { CommandContext } from "./base.js";

export interface FormatOverrides {
  gitmoji?: boolean;
}

export interface RepoContext extends CommandContext {
  repo: RepoInfo;
  loaded: LoadedConfig;
  config: EffectiveConfig;
  lint: LintConfig;
  format: FormatSettings;
  types: TypeInfo[];
  /** Configured, commitlint and history-derived scopes (deduplicated). */
  scopes: string[];
  /** Scopes are restricted by commitlint's scope-enum. */
  scopesStrict: boolean;
  history: string[];
}

export async function loadRepoContext(
  base: CommandContext,
  overrides: FormatOverrides = {},
): Promise<RepoContext> {
  const repo = await getRepo(base.cwd);
  const loaded = loadConfig(repo.root, base.env);
  const config = loaded.effective;
  const lint = await loadLintConfig(repo.root, {
    types: config.format.types,
    headerMaxLength: config.format.headerMaxLength,
    loadJsConfig: config.commitlint.loadJsConfig,
  });
  for (const note of lint.notes) base.ui.info(note);

  const format: FormatSettings = {
    gitmoji: {
      ...config.format.gitmoji,
      enabled: overrides.gitmoji ?? config.format.gitmoji.enabled,
    },
    headerMaxLength: headerLimit(lint, config.format.headerMaxLength),
    bodyWrap: config.format.bodyWrap,
  };

  const history = await recentSubjects(repo, config.smart.historyCount);
  const strictScopes = allowedScopes(lint);
  const historyScopes = history
    .map((s) => parseHeader(s)?.scope)
    .filter((s): s is string => Boolean(s && !/\s/.test(s)));
  const scopes = strictScopes.length
    ? strictScopes
    : [...new Set([...config.format.scopes, ...historyScopes])].slice(0, 30);

  return {
    ...base,
    repo,
    loaded,
    config,
    lint,
    format,
    types: allowedTypes(lint),
    scopes,
    scopesStrict: strictScopes.length > 0,
    history,
  };
}

export function ensureNoOperation(repo: RepoInfo, mode: "smart" | "manual"): void {
  if (!repo.operation) return;
  if (mode === "smart") {
    throw new CliError(`A ${repo.operation} is in progress.`, {
      hint: `Finish it with git (for example \`git ${repo.operation === "merge" ? "commit" : `${repo.operation} --continue`}\`), which already prepared a message.`,
    });
  }
}
