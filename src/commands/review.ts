import { CancelledError, ExitCode } from "../errors.js";
import { commitWithMessage } from "../git/commit.js";
import { stagedFingerprint } from "../git/diff.js";
import { LEADING_GITMOJI_RE } from "../message/gitmoji.js";
import { parseHeader, replaceHeader, stripLeadingGitmoji } from "../message/parse.js";
import { formatIssues, type ValidationReport, validateMessage } from "../message/validate.js";
import type { ProviderId } from "../providers/types.js";
import { c } from "../term.js";
import { editInGitEditor } from "../ui/editor.js";
import type { Choice } from "../ui/ui.js";
import type { RepoContext } from "./context.js";

export interface Revision {
  message: string;
  /** One-line provenance shown under the preview (provider, model, tokens). */
  meta?: string;
  /** Staged-tree fingerprint the message was generated for; checked again before committing. */
  fingerprint?: string;
}

export interface ReviewOptions {
  ctx: RepoContext;
  initial: Revision;
  passthrough: string[];
  regenerate?: (request: { hint?: string; provider?: ProviderId }) => Promise<Revision>;
  providers?: Array<{ id: ProviderId; label: string }>;
  maxRegenerations?: number;
  restart?: () => Promise<Revision>;
}

type Action = "commit" | "edit" | "retype" | "regenerate" | "switch" | "restart" | "cancel";

/**
 * Show the message, its validation result and the available actions until the user commits
 * or cancels. This is the only path that runs `git commit`, and it requires an explicit
 * "Commit" choice; spec violations must be fixed first.
 */
export async function reviewAndCommit(options: ReviewOptions): Promise<number> {
  const { ctx } = options;
  const { ui } = ctx;
  let current = options.initial;
  let regenerations = 0;
  const maxRegenerations = options.maxRegenerations ?? ctx.config.smart.maxRegenerations;

  for (;;) {
    const report = await validateMessage(current.message, ctx.lint);
    showPreview(ctx, current, report);

    const blocked = report.specErrors.length > 0;
    const styleCount = report.styleErrors.length;
    const header = parseHeader(stripLeadingGitmoji(current.message.split("\n")[0] ?? "").text);
    const choices: Choice<Action>[] = [
      blocked
        ? {
            value: "commit",
            label: "Commit",
            disabled: true,
            hint: "fix the errors above first (Edit)",
          }
        : {
            value: "commit",
            label: styleCount
              ? `Commit anyway (${styleCount} style issue${styleCount === 1 ? "" : "s"})`
              : "Commit",
          },
      { value: "edit", label: "Edit in your editor" },
    ];
    if (header) choices.push({ value: "retype", label: "Change type or scope" });
    if (options.regenerate) {
      const left = maxRegenerations - regenerations;
      choices.push(
        left > 0
          ? { value: "regenerate", label: "Regenerate", hint: "optionally with a hint" }
          : {
              value: "regenerate",
              label: "Regenerate",
              disabled: true,
              hint: "limit reached (smart.maxRegenerations)",
            },
      );
      if ((options.providers?.length ?? 0) > 1 && left > 0) {
        choices.push({ value: "switch", label: "Regenerate with another provider" });
      }
    }
    if (options.restart) choices.push({ value: "restart", label: "Start over" });
    choices.push({ value: "cancel", label: "Cancel" });

    const action = await ui.select<Action>({ message: "What would you like to do?", choices });

    switch (action) {
      case "commit": {
        if (styleCount > 0) {
          const ok = await ui.confirm({
            message: `Commit with ${styleCount} commitlint issue${styleCount === 1 ? "" : "s"}? A commit-msg hook may still reject it.`,
            initialValue: false,
          });
          if (!ok) continue;
        }
        if (current.fingerprint && (await stagedFingerprint(ctx.repo)) !== current.fingerprint) {
          const next = await ui.select<"commit" | "regenerate" | "back">({
            message: "The staged changes changed after this message was written.",
            choices: [
              { value: "commit", label: "Commit the new staged changes with this message anyway" },
              ...(options.regenerate
                ? [{ value: "regenerate" as const, label: "Regenerate for the new staged changes" }]
                : []),
              { value: "back", label: "Go back" },
            ],
          });
          if (next === "back") continue;
          if (next === "regenerate" && options.regenerate) {
            regenerations++;
            current = await options.regenerate({});
            continue;
          }
        }
        return commit(ctx, current.message, options.passthrough);
      }
      case "edit": {
        const edited = await editInGitEditor(ctx.repo, current.message, [
          "Conventional Commits: type(scope)!: description, a blank line, body, a blank line, footers.",
        ]);
        if (!edited) ui.warn("The edited message was empty; keeping the previous message.");
        else current = { ...current, message: edited, meta: "edited" };
        break;
      }
      case "retype": {
        if (!header) break;
        const type = await ui.select({
          message: "Type",
          choices: ctx.types.map((t) => ({ value: t.type, label: t.type, hint: t.description })),
          initialValue: ctx.types.some((t) => t.type === header.type) ? header.type : undefined,
        });
        const scope = (
          await ui.text({
            message: "Scope (leave empty for none)",
            initialValue: header.scope ?? "",
            validate: (v) => (/\s/.test(v.trim()) ? "Scopes cannot contain spaces." : undefined),
          })
        ).trim();
        const firstLine = current.message.split("\n")[0] ?? "";
        const prefixEmoji = LEADING_GITMOJI_RE.exec(firstLine)?.[0] ?? "";
        const emoji = header.gitmoji ? `${header.gitmoji} ` : "";
        const newHeader = `${prefixEmoji}${type}${scope ? `(${scope})` : ""}${header.breaking ? "!" : ""}: ${emoji}${header.description}`;
        current = { ...current, message: replaceHeader(current.message, newHeader) };
        break;
      }
      case "regenerate":
      case "switch": {
        if (!options.regenerate) break;
        let request: { hint?: string; provider?: ProviderId } = {};
        if (action === "switch" && options.providers) {
          const provider = await ui.select({
            message: "Provider",
            choices: options.providers.map((p) => ({ value: p.id, label: p.label })),
          });
          request = { provider };
        } else {
          const hint = (
            await ui.text({
              message: "Anything the next suggestion should focus on? (optional)",
              placeholder: "e.g. mention the cache fix",
            })
          ).trim();
          if (hint) request = { hint };
        }
        regenerations++;
        current = await options.regenerate(request);
        break;
      }
      case "restart": {
        if (options.restart) current = await options.restart();
        break;
      }
      case "cancel":
        throw new CancelledError();
    }
  }
}

function showPreview(ctx: RepoContext, revision: Revision, report: ValidationReport): void {
  const { ui } = ctx;
  ui.note(
    revision.message,
    revision.meta ? `Commit message ${c.dim(`· ${revision.meta}`)}` : "Commit message",
  );
  for (const line of formatIssues(report.specErrors)) ui.error(line);
  for (const line of formatIssues(report.styleErrors)) ui.warn(line);
  for (const line of formatIssues(report.warnings)) ui.warn(line);
  if (report.issues.length === 0) ui.success("Valid Conventional Commit.");
}

async function commit(ctx: RepoContext, message: string, passthrough: string[]): Promise<number> {
  const { ui } = ctx;
  ui.step("Running git commit…");
  const result = await commitWithMessage(ctx.repo, message, passthrough);
  if (result.ok) {
    ui.outro(`Committed ${c.bold(result.summary ?? "")}`);
    return ExitCode.Ok;
  }
  ui.error(`git commit exited with code ${result.exitCode} (a hook may have rejected it).`);
  if (result.savedMessagePath)
    ui.info(`Your message was saved. Retry with: ${c.bold("ccli commit --retry")}`);
  return ExitCode.Error;
}
