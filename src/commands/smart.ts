import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type GenerationOutcome, generateCommit } from "../ai/pipeline.js";
import { buildPrompt, buildSystemPrompt, type Prompt, type PromptContext } from "../ai/prompt.js";
import type { Candidate, RouterEvent } from "../ai/router.js";
import { createProviderState, type ProviderState } from "../ai/state.js";
import { setPath, updateGlobalConfig } from "../config/write.js";
import { buildPayload, estimateTokens, type Payload } from "../diff/budget.js";
import { classifyFile, generatedPaths } from "../diff/filter.js";
import { CancelledError, CliError, ExitCode } from "../errors.js";
import { validatePassthrough } from "../git/commit.js";
import { getStagedChanges, stagedFingerprint } from "../git/diff.js";
import { unstage } from "../git/staging.js";
import { createPathPolicy } from "../guard/denylist.js";
import { compileUserPatterns } from "../guard/patterns.js";
import { type Finding, redact, type ScanItem, scanForSecrets } from "../guard/scan.js";
import { createKeyStore, type KeyStore } from "../keys/resolve.js";
import { formatIssues } from "../message/validate.js";
import { resolveEffort } from "../providers/effort.js";
import { ADAPTERS } from "../providers/index.js";
import { PROVIDERS } from "../providers/registry.js";
import { isProviderId, type ProviderAdapter, type ProviderId } from "../providers/types.js";
import { c, debug, writeErr, writeOut } from "../term.js";
import { gitmojiOverride } from "./commit.js";
import {
  type CommandContext,
  ensureNoOperation,
  loadRepoContext,
  type RepoContext,
} from "./context.js";
import { type Revision, reviewAndCommit } from "./review.js";
import { ensureStaged, reportNotIncluded } from "./staging.js";

export interface SmartOptions {
  provider?: string;
  model?: string;
  effort?: string;
  fallback?: boolean;
  all?: boolean;
  print?: boolean;
  hook?: string;
  showPayload?: boolean;
  hint?: string;
  gitmoji?: string | boolean;
}

export interface SmartDeps {
  adapters?: Readonly<Record<ProviderId, ProviderAdapter>>;
  keyStore?: KeyStore;
  state?: ProviderState;
}

interface SafePayload {
  payload: Payload;
  history: string[];
  branch: string | null;
  fingerprint: string;
  withheld: number;
}

/** Smart mode: read staged changes → secret gate → AI draft → validate → review → commit. */
export async function runSmartCommit(
  base: CommandContext,
  options: SmartOptions,
  passthrough: string[],
  deps: SmartDeps = {},
): Promise<number> {
  validatePassthrough(passthrough);
  const hookFile = options.hook;
  if (hookFile !== undefined && hasMessageContent(hookFile)) return ExitCode.Ok;

  const ctx = await loadRepoContext(base, gitmojiOverride(options.gitmoji));
  if (!ctx.config.smart.enabled) {
    throw new CliError(
      ctx.config.smart.disabledByRepo
        ? "Smart mode is disabled for this repository (.ccli.json sets smart.enabled to false)."
        : "Smart mode is disabled in your configuration (smart.enabled is false).",
      { hint: "Use `ccli commit` to write the message yourself." },
    );
  }
  ensureNoOperation(ctx.repo, "smart");

  const outputOnly = Boolean(options.print || hookFile !== undefined || options.showPayload);
  if (!outputOnly && !ctx.ui.interactive) {
    throw new CliError(
      "smart commit needs an interactive terminal so you can review the message before it is committed.",
      {
        exitCode: ExitCode.Usage,
        hint: "Use --print to output the generated message without committing.",
      },
    );
  }
  if (!outputOnly) ctx.ui.intro("Smart commit");

  const staging = await ensureStaged(ctx, { stageAll: options.all ?? false });
  try {
    if (!outputOnly) reportNotIncluded(ctx, staging.status);

    const keyStore = deps.keyStore ?? createKeyStore(ctx.env);
    let candidates = options.showPayload
      ? []
      : await resolveCandidates(ctx, options, keyStore, deps.adapters ?? ADAPTERS);
    if (!options.showPayload) candidates = await ensureAcknowledged(ctx, candidates);

    const safe = await buildSafePayload(ctx, outputOnly);
    const promptContext = makePromptContext(ctx, safe, options.hint);

    if (options.showPayload) {
      await writeOut(formatPrompt(buildPrompt(safe.payload, promptContext), candidates));
      return ExitCode.Ok;
    }

    const state = deps.state ?? createProviderState(ctx.env);
    const outcome = await generate(ctx, safe, promptContext, candidates, state);
    const message = await sanitizeGenerated(ctx, outcome.message);

    if (outputOnly) {
      for (const line of formatIssues(outcome.report.issues)) writeErr(`${line}\n`);
      if (hookFile !== undefined) writeHookFile(hookFile, message);
      else await writeOut(`${message}\n`);
      return ExitCode.Ok;
    }

    let lastHeader = message.split("\n")[0] ?? "";
    return await reviewAndCommit({
      ctx,
      initial: { message, meta: metaLine(outcome), fingerprint: safe.fingerprint },
      passthrough,
      providers: candidates.map((cand) => ({
        id: cand.id,
        label: `${PROVIDERS[cand.id].displayName} (${cand.settings.model})`,
      })),
      regenerate: async ({ hint, provider }): Promise<Revision> => {
        // Re-read and re-scan: the staged changes may have changed since the first draft.
        const fresh = await buildSafePayload(ctx, false);
        const ordered = provider
          ? [
              ...candidates.filter((cand) => cand.id === provider),
              ...candidates.filter((cand) => cand.id !== provider),
            ]
          : candidates;
        const next = await generate(
          ctx,
          fresh,
          { ...makePromptContext(ctx, fresh, hint), avoidHeader: lastHeader },
          ordered,
          state,
        );
        const text = await sanitizeGenerated(ctx, next.message);
        lastHeader = text.split("\n")[0] ?? "";
        return { message: text, meta: metaLine(next), fingerprint: fresh.fingerprint };
      },
    });
  } catch (error) {
    if (error instanceof CancelledError && staging.stagedByUs.length > 0) {
      await unstage(ctx.repo, staging.stagedByUs);
      ctx.ui.info("Restored the index: the files ccli staged are unstaged again.");
    }
    throw error;
  }
}

/** Build the candidate list: configured order ∩ repository allow-list, enabled, with a key. */
export async function resolveCandidates(
  ctx: RepoContext,
  options: SmartOptions,
  keyStore: KeyStore,
  adapters: Readonly<Record<ProviderId, ProviderAdapter>>,
): Promise<Candidate[]> {
  const { providers } = ctx.config;
  let order = providers.order.filter((id) => !providers.allow || providers.allow.includes(id));
  if (providers.allow && order.length === 0) {
    throw new CliError(
      `This repository only allows ${providers.allow.join(", ")}, and none of them is in your provider order.`,
      {
        hint: `Add one with: ccli config set providers.order ${providers.allow.join(",")}`,
      },
    );
  }

  if (options.provider) {
    const requested = options.provider.toLowerCase();
    if (!isProviderId(requested)) {
      throw new CliError(
        `Unknown provider "${options.provider}". Choose one of: openai, anthropic, xai, gemini.`,
        {
          exitCode: ExitCode.Usage,
        },
      );
    }
    if (providers.allow && !providers.allow.includes(requested)) {
      throw new CliError(
        `This repository does not allow ${requested} (.ccli.json providers.allow).`,
      );
    }
    order = [requested, ...order.filter((id) => id !== requested)];
  }
  if (options.fallback === false) order = order.slice(0, 1);

  const primary = order[0];
  const candidates: Candidate[] = [];
  const missing: string[] = [];
  for (const id of order) {
    const settings = providers.settings[id];
    if (!settings.enabled) {
      debug(`${id} skipped: disabled in config`);
      continue;
    }
    const key = await keyStore.resolve(id);
    if (!key) {
      missing.push(id);
      continue;
    }
    const isPrimary = id === primary;
    const model = isPrimary && options.model ? options.model : settings.model;
    const effort = resolveEffort(
      id,
      model,
      isPrimary && options.effort ? options.effort : settings.effort,
    );
    if (effort.warning) ctx.ui.warn(effort.warning);
    const adapter = adapters[id];
    candidates.push({
      id,
      adapter,
      structured: settings.structuredOutput,
      settings: {
        apiKey: key.value,
        model,
        effort: effort.value,
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        baseUrl: settings.baseUrl ?? adapter.defaultBaseUrl,
      },
    });
  }

  if ((options.model || options.effort) && primary && candidates[0]?.id !== primary) {
    ctx.ui.warn(
      `--model/--effort apply to ${primary}, which is not available (no API key or disabled).`,
    );
  }
  if (candidates.length === 0) {
    const envList = (missing.length ? missing : order)
      .map(
        (id) =>
          `${PROVIDERS[id as ProviderId].envVars[0]} (${PROVIDERS[id as ProviderId].displayName})`,
      )
      .join(", ");
    throw new CliError("No AI provider is ready: no API key was found.", {
      hint: `Set one of ${envList}, or store a key with \`ccli auth set <provider>\`. \`ccli config init\` walks you through setup.`,
    });
  }
  return candidates;
}

/** First use of a provider requires a one-time acknowledgement that diffs will be sent to it. */
export async function ensureAcknowledged(
  ctx: RepoContext,
  candidates: Candidate[],
): Promise<Candidate[]> {
  const acknowledged = new Set(ctx.config.smart.acknowledgedProviders);
  const pending = candidates.filter((cand) => !acknowledged.has(cand.id));
  if (pending.length === 0) return candidates;

  if (!ctx.ui.interactive) {
    for (const cand of pending) {
      ctx.ui.warn(
        `Skipping ${PROVIDERS[cand.id].displayName}: sending diffs to it has not been approved yet.`,
      );
    }
    const approved = candidates.filter((cand) => acknowledged.has(cand.id));
    if (approved.length === 0) {
      throw new CliError("No provider has been approved for receiving diffs.", {
        hint: "Run `ccli smart commit` once in a terminal to approve, or: ccli config set smart.acknowledgedProviders <ids>",
      });
    }
    return approved;
  }

  ctx.ui.note(
    [
      "Smart mode sends your staged diff, the file list, recent commit subjects and the branch name",
      "(after withholding sensitive files and detected secrets) to:",
      ...pending.map((cand) => `  • ${PROVIDERS[cand.id].displayName} — ${cand.settings.model}`),
      "",
      "Nothing is sent anywhere else, and nothing is committed without your approval.",
    ].join("\n"),
    "Before the first request",
  );
  const ok = await ctx.ui.confirm({
    message: "Allow sending diffs to these providers? (remembered in your global config)",
  });
  if (!ok) throw new CancelledError("Nothing was sent or committed.");
  updateGlobalConfig(ctx.loaded.globalPath, (cfg) =>
    setPath(cfg, "smart.acknowledgedProviders", [
      ...acknowledged,
      ...pending.map((cand) => cand.id),
    ]),
  );
  return candidates;
}

/** Read staged changes, withhold what must not be sent, and run the secret gate on the exact payload. */
export async function buildSafePayload(
  ctx: RepoContext,
  outputOnly: boolean,
): Promise<SafePayload> {
  const changes = await getStagedChanges(ctx.repo);
  if (changes.files.length === 0)
    throw new CliError("Nothing is staged.", { hint: "Stage changes with `git add`." });

  const policy = createPathPolicy(ctx.config.secrets.denyGlobs);
  const generated = await generatedPaths(
    ctx.repo,
    changes.files.map((f) => f.path),
  );
  const sensitive = changes.files.filter((f) => policy.isDenied(f.path));
  for (const f of sensitive) {
    ctx.ui.warn(
      `You are committing ${c.bold(f.path)}, which usually holds secrets. Its content will not be sent.`,
    );
  }

  const { patterns, errors } = compileUserPatterns(ctx.config.secrets.extraPatterns);
  for (const e of errors) ctx.ui.warn(e);

  const withheld = new Set<string>();
  let history = [...ctx.history];
  let branch = ctx.repo.branch;
  const overhead =
    estimateTokens(buildSystemPrompt(makePromptContext(ctx, { history, branch }, undefined))) +
    estimateTokens(history.join("\n")) +
    changes.files.length * 25 +
    400;
  const maxDiffTokens = Math.max(1_000, ctx.config.smart.maxInputTokens - overhead);
  const build = () =>
    buildPayload(
      changes.files,
      (f) => (withheld.has(f.path) ? "possible secret" : classifyFile(f, policy, generated)),
      {
        maxDiffTokens,
        largeChangeFiles: ctx.config.smart.largeChangeFiles,
        largeChangeLines: ctx.config.smart.largeChangeLines,
      },
    );

  let payload = build();
  if (changes.truncated) ctx.ui.warn("The staged diff is very large; only part of it was read.");

  // Fail closed: loop until the exact payload scans clean or the user explicitly chose to send.
  let clean = false;
  for (let round = 0; round < 5 && !clean; round++) {
    const findings = await scanForSecrets(scanItems(payload, history, branch), {
      extraPatterns: patterns,
    });
    if (findings.length === 0) {
      clean = true;
      break;
    }
    const decision = await decideOnFindings(ctx, findings, outputOnly);
    if (decision === "abort")
      throw new CancelledError(
        "Stopped: possible secrets were found. Nothing was sent or committed.",
      );
    if (decision === "send") {
      clean = true;
      break;
    }
    const bySource = groupBy(findings, (f) => f.source);
    if (decision === "exclude") {
      for (const source of bySource.keys()) {
        if (source === HISTORY_SOURCE) history = dropLines(history, bySource.get(source) ?? []);
        else if (source === BRANCH_SOURCE) branch = null;
        else withheld.add(source);
      }
      payload = build();
    } else {
      for (const file of payload.files) {
        const hits = bySource.get(file.path);
        if (hits) file.text = redact(file.text, hits);
      }
      const historyHits = bySource.get(HISTORY_SOURCE);
      if (historyHits) history = redact(history.join("\n"), historyHits).split("\n");
      if (bySource.has(BRANCH_SOURCE) && branch)
        branch = redact(branch, bySource.get(BRANCH_SOURCE) ?? []);
    }
  }
  if (!clean) {
    throw new CliError(
      "Possible secrets could not be removed from the payload. Nothing was sent or committed.",
      {
        hint: "Add the files to .ccliignore, or write the message with `ccli commit`.",
      },
    );
  }

  if (payload.large) {
    ctx.ui.info(
      `Large change (${changes.files.length} files, ${payload.changedLines} lines). Consider splitting it into smaller commits; the message will summarise it.`,
    );
  }
  return {
    payload,
    history,
    branch,
    fingerprint: await stagedFingerprint(ctx.repo),
    withheld: withheld.size,
  };
}

const HISTORY_SOURCE = "recent commit subjects";
const BRANCH_SOURCE = "branch name";

function scanItems(payload: Payload, history: string[], branch: string | null): ScanItem[] {
  const items: ScanItem[] = payload.files
    .filter((f) => f.text)
    .map((f) => ({ source: f.path, text: f.text, lineRefs: f.lineRefs }));
  if (history.length) items.push({ source: HISTORY_SOURCE, text: history.join("\n") });
  if (branch) items.push({ source: BRANCH_SOURCE, text: branch });
  return items;
}

async function decideOnFindings(
  ctx: RepoContext,
  findings: Finding[],
  outputOnly: boolean,
): Promise<"exclude" | "redact" | "send" | "abort"> {
  const { ui } = ctx;
  const shown = findings
    .slice(0, 15)
    .map((f) => `  • ${f.source} (${f.location}) — ${f.rule}: ${f.masked}`);
  if (findings.length > shown.length) shown.push(`  … and ${findings.length - shown.length} more`);
  ui.warn(`Possible secrets in the content that would be sent:\n${shown.join("\n")}`);

  const configured = ctx.config.secrets.onDetect;
  if (configured !== "ask") return configured;
  if (!ui.interactive || outputOnly) {
    ui.info("Withholding the affected content (secrets.onDetect=ask, no terminal to ask).");
    return "exclude";
  }
  const choice = await ui.select<"exclude" | "redact" | "send" | "abort">({
    message: "Nothing has been sent. How should these be handled?",
    choices: [
      { value: "exclude", label: "Withhold the affected files' content", hint: "recommended" },
      { value: "redact", label: "Redact only the matches and send the rest" },
      { value: "send", label: "Send anyway", hint: "only if these are false positives" },
      { value: "abort", label: "Stop" },
    ],
  });
  if (choice === "send") {
    await ui.text({
      message: 'Type "send" to confirm sending this content to the AI provider',
      validate: (v) =>
        v.trim() === "send" ? undefined : 'Type "send" to confirm, or press Ctrl+C to stop.',
    });
  }
  return choice;
}

function makePromptContext(
  ctx: RepoContext,
  safe: Pick<SafePayload, "history" | "branch">,
  hint: string | undefined,
): PromptContext {
  return {
    types: ctx.types,
    scopes: ctx.scopes,
    scopesStrict: ctx.scopesStrict,
    gitmoji: ctx.format.gitmoji.enabled,
    headerMaxLength: ctx.format.headerMaxLength,
    language: ctx.config.smart.language,
    branch: safe.branch,
    history: safe.history,
    ...(hint ? { hint } : {}),
  };
}

async function generate(
  ctx: RepoContext,
  safe: SafePayload,
  promptContext: PromptContext,
  candidates: Candidate[],
  state: ProviderState,
): Promise<GenerationOutcome> {
  const { ui } = ctx;
  const sent = safe.payload.files.filter((f) => f.text).length;
  const summarized = safe.payload.files.length - sent;
  const chain = candidates.map((cand) => PROVIDERS[cand.id].displayName).join(" → ");
  ui.step(
    `Sending ${sent} file diff${sent === 1 ? "" : "s"}${summarized ? ` (+${summarized} listed without content)` : ""} · ~${formatTokens(safe.payload.diffTokens)} diff tokens · ${chain}`,
  );

  const spinner = ui.spinner();
  const first = candidates[0];
  spinner.start(`Writing the message with ${first ? PROVIDERS[first.id].displayName : "AI"}…`);
  const onEvent = (event: RouterEvent) => {
    if (event.type === "attempt")
      spinner.message(
        `Writing the message with ${PROVIDERS[event.provider].displayName} (${event.model})…`,
      );
    if (event.type === "retry")
      spinner.message(`${PROVIDERS[event.provider].displayName}: ${event.reason} — retrying…`);
    if (event.type === "fallback") ui.warn(`${PROVIDERS[event.from].displayName}: ${event.reason}`);
    if (event.type === "skip") debug(`${event.provider} skipped: ${event.reason}`);
  };
  try {
    const outcome = await generateCommit({
      payload: safe.payload,
      context: promptContext,
      candidates,
      router: { state, budgetMs: ctx.config.smart.requestBudgetMs, signal: ctx.signal, onEvent },
      lint: ctx.lint,
      format: ctx.format,
      allowedTypes: ctx.types,
      onRepair: (problems) => {
        debug(`repairing draft: ${problems.join("; ")}`);
        spinner.message("Fixing format issues in the draft…");
      },
    });
    spinner.stop(ui.interactive ? "Message ready" : `Message ready · ${metaLine(outcome)}`);
    return outcome;
  } catch (error) {
    spinner.error(error instanceof CancelledError ? "Cancelled." : "Could not generate a message.");
    throw error;
  }
}

/** The model output is re-scanned: anything that looks like a secret is redacted before display. */
async function sanitizeGenerated(ctx: RepoContext, message: string): Promise<string> {
  const findings = await scanForSecrets([{ source: "generated message", text: message }]);
  if (findings.length === 0) return message;
  ctx.ui.warn(
    "The generated message contained something that looks like a secret; it was redacted. Review it carefully.",
  );
  return redact(message, findings);
}

function metaLine(outcome: GenerationOutcome): string {
  const tokens =
    outcome.usage.inputTokens || outcome.usage.outputTokens
      ? ` · ${formatTokens(outcome.usage.inputTokens)} in / ${formatTokens(outcome.usage.outputTokens)} out`
      : "";
  const repairs = outcome.repairs
    ? ` · ${outcome.repairs} repair${outcome.repairs === 1 ? "" : "s"}`
    : "";
  return `${PROVIDERS[outcome.provider].displayName} ${outcome.model}${tokens} · ${(outcome.latencyMs / 1000).toFixed(1)} s${repairs}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatPrompt(prompt: Prompt, candidates: Candidate[]): string {
  const note = candidates.length
    ? candidates.map((cand) => `${cand.id}:${cand.settings.model}`).join(", ")
    : "(not resolved with --show-payload; nothing is sent)";
  return [
    "# Payload preview — nothing was sent",
    `# Providers: ${note}`,
    "",
    "## System prompt",
    prompt.system,
    "",
    "## User content",
    prompt.user,
    "",
  ].join("\n");
}

/** In hook mode git has prepared the message file; leave it alone if it already has a message. */
function hasMessageContent(file: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .some((line) => line.trim() && !line.startsWith("#"));
}

function writeHookFile(file: string, message: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${message}\n${existing.startsWith("\n") ? "" : "\n"}${existing}`, "utf8");
}

function dropLines(lines: string[], findings: Finding[]): string[] {
  const drop = new Set(findings.map((f) => f.line - 1));
  return lines.filter((_, i) => !drop.has(i));
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}
