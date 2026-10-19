import { CancelledError, CliError, ExitCode } from "../errors.js";
import { loadLastMessage, validatePassthrough } from "../git/commit.js";
import { unstage } from "../git/staging.js";
import { defaultGitmoji, findGitmoji, gitmojisForType } from "../message/gitmoji.js";
import { normalizeScope } from "../message/normalize.js";
import { FOOTER_LINE_RE, renderHeader, renderMessage } from "../message/render.js";
import { type CommitDraft, emptyDraft, type Footer } from "../message/types.js";
import { formatIssues, validateMessage } from "../message/validate.js";
import { writeErr, writeOut } from "../term.js";
import {
  type CommandContext,
  ensureNoOperation,
  loadRepoContext,
  type RepoContext,
} from "./context.js";
import { reviewAndCommit } from "./review.js";
import { ensureStaged, reportNotIncluded } from "./staging.js";

export interface CommitOptions {
  type?: string;
  scope?: string;
  message?: string;
  body?: string;
  breaking?: string | boolean;
  footer?: string[];
  gitmoji?: string | boolean;
  print?: boolean;
  retry?: boolean;
  all?: boolean;
}

const NO_GITMOJI = "";

/** Manual mode: guided prompts (or flags) → preview → explicit confirmation → git commit. */
export async function runCommit(
  base: CommandContext,
  options: CommitOptions,
  passthrough: string[],
): Promise<number> {
  validatePassthrough(passthrough);
  const ctx = await loadRepoContext(base, gitmojiOverride(options.gitmoji));
  ensureNoOperation(ctx.repo, "manual");
  const allowEmpty = passthrough.includes("--allow-empty");

  if (options.retry) {
    const saved = loadLastMessage(ctx.repo);
    if (!saved)
      throw new CliError("There is no saved message to retry.", {
        hint: "Messages are saved when git commit fails.",
      });
    if (options.print) {
      await writeOut(`${saved}\n`);
      return ExitCode.Ok;
    }
    requireInteractive(ctx);
    ctx.ui.intro("Retry commit");
    await ensureStaged(ctx, { allowEmpty });
    return reviewAndCommit({
      ctx,
      initial: { message: saved, meta: "saved message" },
      passthrough,
    });
  }

  const prefill = draftFromFlags(options);

  if (options.print) {
    if (!prefill.type || !prefill.description) {
      throw new CliError("--print needs at least --type and --message.", {
        exitCode: ExitCode.Usage,
      });
    }
    const message = renderMessage({ ...emptyDraft(prefill.type), ...prefill }, ctx.format);
    const report = await validateMessage(message, ctx.lint);
    for (const line of formatIssues(report.issues)) writeErr(`${line}\n`);
    if (report.specErrors.length > 0) return ExitCode.Error;
    await writeOut(`${message}\n`);
    return ExitCode.Ok;
  }

  requireInteractive(ctx);
  ctx.ui.intro("Conventional commit");
  const staging = await ensureStaged(ctx, { stageAll: options.all ?? false, allowEmpty });
  reportNotIncluded(ctx, staging.status);

  try {
    const draft = await promptDraft(ctx, prefill);
    return await reviewAndCommit({
      ctx,
      initial: { message: renderMessage(draft, ctx.format) },
      passthrough,
      restart: async () => ({ message: renderMessage(await promptDraft(ctx, {}), ctx.format) }),
    });
  } catch (error) {
    if (error instanceof CancelledError && staging.stagedByUs.length > 0) {
      await unstage(ctx.repo, staging.stagedByUs);
      ctx.ui.info("Restored the index: the files ccli staged are unstaged again.");
    }
    throw error;
  }
}

function requireInteractive(ctx: RepoContext): void {
  if (!ctx.ui.interactive) {
    throw new CliError("Interactive commit needs a terminal.", {
      exitCode: ExitCode.Usage,
      hint: "Use --print with --type and --message to output a message for scripts.",
    });
  }
}

export function gitmojiOverride(flag: string | boolean | undefined): { gitmoji?: boolean } {
  if (flag === undefined) return {};
  if (typeof flag === "boolean") return { gitmoji: flag };
  return { gitmoji: true };
}

export function draftFromFlags(options: CommitOptions): Partial<CommitDraft> {
  const draft: Partial<CommitDraft> = {};
  if (options.type) draft.type = options.type.trim().toLowerCase();
  if (options.scope !== undefined) draft.scope = normalizeScope(options.scope);
  if (options.message) draft.description = options.message.trim();
  if (options.body) draft.body = options.body.replace(/\\n/g, "\n").trim() || null;
  if (options.breaking !== undefined && options.breaking !== false) {
    draft.breaking = true;
    draft.breakingDescription =
      typeof options.breaking === "string" && options.breaking.trim()
        ? options.breaking.trim()
        : null;
  }
  if (options.footer?.length) draft.footers = options.footer.map(parseFooterFlag);
  if (typeof options.gitmoji === "string") {
    const found = findGitmoji(options.gitmoji);
    if (!found)
      throw new CliError(`Unknown gitmoji "${options.gitmoji}".`, { exitCode: ExitCode.Usage });
    draft.gitmoji = found.code;
  }
  return draft;
}

export function parseFooterFlag(value: string): Footer {
  const trimmed = value.trim();
  const m = FOOTER_LINE_RE.exec(trimmed);
  if (!m) {
    throw new CliError(
      `Footer "${value}" must look like "Token: value" or "Token #value", e.g. "Refs: #123".`,
      {
        exitCode: ExitCode.Usage,
      },
    );
  }
  const rest = trimmed.slice(m[0].length);
  return { token: m[1] ?? "", value: m[2] === " #" ? `#${rest}` : rest };
}

/** Prompt for each field that the flags did not provide. */
export async function promptDraft(
  ctx: RepoContext,
  prefill: Partial<CommitDraft>,
): Promise<CommitDraft> {
  const { ui, format } = ctx;
  const draft: CommitDraft = { ...emptyDraft(), ...prefill, footers: [...(prefill.footers ?? [])] };

  if (!prefill.type) {
    draft.type = await ui.select({
      message: "Type of change",
      choices: ctx.types.map((t) => ({ value: t.type, label: t.type, hint: t.description })),
      maxItems: 12,
    });
  }

  if (prefill.scope === undefined) draft.scope = await promptScope(ctx);

  if (format.gitmoji.enabled && !prefill.gitmoji) {
    const suggested = defaultGitmoji(draft.type, false);
    const ordered = gitmojisForType(draft.type);
    const picked = await ui.search<string>({
      message: "Gitmoji",
      placeholder: "Type to search, e.g. bug, docs, perf",
      choices: [
        ...(suggested ? [] : [{ value: NO_GITMOJI, label: "No gitmoji" }]),
        ...ordered.map((g) => ({
          value: g.code,
          label: `${g.emoji}  ${g.code}`,
          hint: g.code === suggested ? `suggested · ${g.description}` : g.description,
        })),
        ...(suggested ? [{ value: NO_GITMOJI, label: "No gitmoji" }] : []),
      ],
    });
    // "" records an explicit "no gitmoji"; null would fall back to the type's default.
    draft.gitmoji = picked;
  }

  if (!prefill.description) {
    draft.description = (
      await ui.text({
        message: "Short description (imperative, e.g. “add login with OAuth”)",
        validate: (value) => validateDescription(ctx, draft, value),
      })
    ).trim();
  }

  if (prefill.body === undefined || prefill.body === null) {
    const body = await ui.multiline({
      message: "Body (optional) — what changed and why. Press Enter twice to finish.",
      placeholder: "Leave empty to skip",
    });
    draft.body = body.trim() || null;
  }

  if (prefill.breaking === undefined || prefill.breaking === false) {
    draft.breaking = await ui.confirm({
      message: "Is this a breaking change?",
      initialValue: false,
    });
    if (draft.breaking) {
      const what = await ui.text({
        message: "Describe what breaks and how to migrate (optional; the ! marker alone is valid)",
        placeholder: "e.g. the `extends` key now merges configs instead of replacing them",
      });
      draft.breakingDescription = what.trim() || null;
    }
  }

  if (!prefill.footers?.length) {
    const refs = await ui.text({
      message: "Related issues (optional, e.g. #123, PROJ-45)",
      placeholder: "Leave empty to skip",
    });
    if (refs.trim()) draft.footers.push({ token: "Refs", value: refs.trim() });
  }

  return draft;
}

async function promptScope(ctx: RepoContext): Promise<string | null> {
  const { ui } = ctx;
  const CUSTOM = "\u0000custom";
  const NONE = "\u0000none";
  if (ctx.scopes.length > 0) {
    const picked = await ui.select<string>({
      message: ctx.scopesStrict ? "Scope (restricted by commitlint)" : "Scope",
      choices: [
        { value: NONE, label: "(none)" },
        ...ctx.scopes.map((s) => ({ value: s, label: s })),
        ...(ctx.scopesStrict ? [] : [{ value: CUSTOM, label: "Custom…" }]),
      ],
      maxItems: 12,
    });
    if (picked === NONE) return null;
    if (picked !== CUSTOM) return picked;
  }
  const typed = await ui.text({
    message: "Scope (optional — the area affected, e.g. api, parser)",
    placeholder: "Leave empty for none",
    validate: (value) =>
      /\s/.test(value.trim()) ? "Use a single word or hyphenate it, e.g. auth-api." : undefined,
  });
  return normalizeScope(typed);
}

export function validateDescription(
  ctx: RepoContext,
  draft: CommitDraft,
  value: string,
): string | undefined {
  const text = value.trim();
  if (!text) return "A description is required.";
  if (/\n/.test(value)) return "Keep the description on one line; use the body for details.";
  if (/\.$/.test(text)) return "Leave out the trailing period.";
  const length = renderHeader({ ...draft, description: text }, ctx.format).length;
  if (length > ctx.format.headerMaxLength) {
    return `The header would be ${length} characters; the limit is ${ctx.format.headerMaxLength}. Shorten it by ${length - ctx.format.headerMaxLength}.`;
  }
  return undefined;
}
