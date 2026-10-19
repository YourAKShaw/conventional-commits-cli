import type { Payload } from "../diff/budget.js";
import { CliError } from "../errors.js";
import type { LintConfig } from "../message/commitlint.js";
import { normalizeDraft } from "../message/normalize.js";
import { renderMessage } from "../message/render.js";
import type { CommitDraft, FormatSettings, TypeInfo } from "../message/types.js";
import { isClean, type ValidationReport, validateMessage } from "../message/validate.js";
import type { ProviderId } from "../providers/types.js";
import { buildPrompt, buildRepairPrompt, type Prompt, type PromptContext } from "./prompt.js";
import { type AttemptLog, type Candidate, type RouterOptions, routeGenerate } from "./router.js";
import { parseModelOutput, responseJsonSchema } from "./schema.js";

export interface PipelineOptions {
  payload: Payload;
  context: PromptContext;
  candidates: readonly Candidate[];
  router: RouterOptions;
  lint: LintConfig;
  format: FormatSettings;
  allowedTypes: readonly TypeInfo[];
  maxRepairs?: number;
  onRepair?: (problems: string[]) => void;
}

export interface GenerationOutcome {
  draft: CommitDraft;
  message: string;
  report: ValidationReport;
  provider: ProviderId;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  repairs: number;
  attempts: AttemptLog[];
  prompt: Prompt;
}

/**
 * Generate → parse → normalise → render → validate, with up to `maxRepairs` repair rounds
 * that feed validation errors back to the model. Returns the last valid-shaped draft even if
 * style errors remain, so the user can edit it; nothing here commits.
 */
export async function generateCommit(options: PipelineOptions): Promise<GenerationOutcome> {
  const maxRepairs = options.maxRepairs ?? 2;
  const base = buildPrompt(options.payload, options.context);
  const schema = responseJsonSchema(options.allowedTypes.map((t) => t.type));
  const usage = { inputTokens: 0, outputTokens: 0 };
  const attempts: AttemptLog[] = [];
  let latencyMs = 0;
  let prompt = base;
  let candidates = [...options.candidates];
  let last: GenerationOutcome | null = null;
  let lastError = "";

  for (let repairs = 0; ; repairs++) {
    const routed = await routeGenerate(
      candidates,
      { system: prompt.system, user: prompt.user, schema, schemaName: "conventional_commit" },
      options.router,
    );
    attempts.push(...routed.attempts);
    usage.inputTokens += routed.result.usage?.inputTokens ?? 0;
    usage.outputTokens += routed.result.usage?.outputTokens ?? 0;
    latencyMs += routed.result.latencyMs;

    let problems: string[];
    const parsed = parseModelOutput(routed.result.text);
    if (!parsed.ok) {
      problems = [parsed.error];
      lastError = parsed.error;
    } else {
      const draft = normalizeDraft(parsed.draft, [...options.allowedTypes]);
      if (!options.format.gitmoji.enabled) draft.gitmoji = null;
      const message = renderMessage(draft, options.format);
      const report = await validateMessage(message, options.lint);
      last = {
        draft,
        message,
        report,
        provider: routed.candidate.id,
        model: routed.result.model || routed.candidate.settings.model,
        usage: { ...usage },
        latencyMs,
        repairs,
        attempts: [...attempts],
        prompt: base,
      };
      if (isClean(report)) return last;
      problems = [...report.specErrors, ...report.styleErrors].map(
        (i) => `${i.message} (${i.rule})`,
      );
      if (message.split("\n")[0]!.length > options.format.headerMaxLength) {
        problems.push(
          `The header is ${message.split("\n")[0]!.length} characters; shorten the description so the header is at most ${options.format.headerMaxLength}.`,
        );
      }
    }

    if (repairs >= maxRepairs) {
      if (last) return last;
      throw new CliError(`The AI response could not be used: ${lastError}`, {
        hint: "Try `Regenerate`, another provider (--provider), or write the message with `ccli commit`.",
      });
    }
    options.onRepair?.(problems);
    prompt = buildRepairPrompt(base, routed.result.text, problems);
    // Repairs go to the provider that produced the draft first, then the remaining fallbacks.
    candidates = [
      routed.candidate,
      ...options.candidates.filter((c) => c.id !== routed.candidate.id),
    ];
  }
}
