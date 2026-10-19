import { setTimeout as sleepTimer } from "node:timers/promises";
import { CancelledError, CliError } from "../errors.js";
import { PROVIDERS } from "../providers/registry.js";
import {
  type CallSettings,
  type GenerateRequest,
  type GenerateResult,
  type ProviderAdapter,
  ProviderError,
  type ProviderId,
} from "../providers/types.js";
import { EXHAUSTED_TTL_MS, HEURISTIC_EXHAUSTED_TTL_MS, type ProviderState } from "./state.js";

export interface Candidate {
  id: ProviderId;
  adapter: ProviderAdapter;
  settings: Omit<CallSettings, "signal">;
  structured: boolean;
}

export interface AttemptLog {
  provider: ProviderId;
  attempt: number;
  ok: boolean;
  kind?: ProviderError["kind"];
  message?: string;
  latencyMs?: number;
}

export type RouterEvent =
  | { type: "attempt"; provider: ProviderId; model: string; attempt: number }
  | { type: "retry"; provider: ProviderId; reason: string; delayMs: number }
  | { type: "fallback"; from: ProviderId; reason: string }
  | { type: "skip"; provider: ProviderId; reason: string };

export interface RouterOptions {
  state: ProviderState;
  budgetMs: number;
  signal?: AbortSignal;
  onEvent?: (event: RouterEvent) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface RouteResult {
  result: GenerateResult;
  candidate: Candidate;
  attempts: AttemptLog[];
}

const MAX_RETRY_AFTER_MS = 5_000;
const MAX_OUTPUT_TOKENS_CAP = 32_768;

/**
 * Try providers in order. Each provider gets at most two attempts; the second only happens
 * for transient failures (rate limit with a short Retry-After, overload, network, timeout)
 * or truncated output (retried with a doubled output limit). Quota/credit exhaustion falls
 * back immediately and is remembered for a while. Generation has no side effects, so the
 * bounds exist only to cap latency and cost.
 */
export async function routeGenerate(
  candidates: readonly Candidate[],
  request: Omit<GenerateRequest, "structured">,
  options: RouterOptions,
): Promise<RouteResult> {
  if (candidates.length === 0) throw new CliError("No AI provider is available.");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.budgetMs;
  const attempts: AttemptLog[] = [];

  const allExhausted = candidates.every((c) => options.state.isExhausted(c.id));
  for (const candidate of candidates) {
    if (!allExhausted && options.state.isExhausted(candidate.id)) {
      options.onEvent?.({
        type: "skip",
        provider: candidate.id,
        reason: "recently reported no credits/quota",
      });
      continue;
    }
    let maxOutputTokens = candidate.settings.maxOutputTokens;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw budgetError(options.budgetMs, attempts);
      if (options.signal?.aborted) throw new CancelledError();
      options.onEvent?.({
        type: "attempt",
        provider: candidate.id,
        model: candidate.settings.model,
        attempt,
      });
      try {
        const result = await candidate.adapter.generate(
          { ...request, structured: candidate.structured },
          {
            ...candidate.settings,
            maxOutputTokens,
            timeoutMs: Math.min(candidate.settings.timeoutMs, remaining),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        attempts.push({ provider: candidate.id, attempt, ok: true, latencyMs: result.latencyMs });
        options.state.clear(candidate.id);
        return { result, candidate, attempts };
      } catch (error) {
        const e =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                candidate.id,
                "invalid_response",
                (error as Error)?.message ?? String(error),
              );
        attempts.push({
          provider: candidate.id,
          attempt,
          ok: false,
          kind: e.kind,
          message: e.message,
        });
        if (e.kind === "cancelled" || options.signal?.aborted) throw new CancelledError();

        const retry = retryDecision(e, attempt);
        if (retry) {
          if (e.kind === "truncated")
            maxOutputTokens = Math.min(maxOutputTokens * 2, MAX_OUTPUT_TOKENS_CAP);
          options.onEvent?.({
            type: "retry",
            provider: candidate.id,
            reason: e.message,
            delayMs: retry.delayMs,
          });
          if (retry.delayMs > 0) await sleep(retry.delayMs, options.signal);
          continue;
        }
        if (e.kind === "quota") {
          options.state.markExhausted(
            candidate.id,
            e.heuristic ? HEURISTIC_EXHAUSTED_TTL_MS : EXHAUSTED_TTL_MS,
            e.message,
          );
        }
        options.onEvent?.({ type: "fallback", from: candidate.id, reason: e.message });
        break;
      }
    }
  }
  throw allFailedError(attempts);
}

function retryDecision(error: ProviderError, attempt: number): { delayMs: number } | null {
  if (attempt >= 2) return null;
  switch (error.kind) {
    case "rate_limit": {
      const wait = error.retryAfterMs ?? 1_000;
      return wait <= MAX_RETRY_AFTER_MS ? { delayMs: wait } : null;
    }
    case "overloaded":
    case "network":
    case "timeout":
      return { delayMs: 500 + Math.floor(Math.random() * 1_000) };
    case "truncated":
      return { delayMs: 0 };
    default:
      return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepTimer(ms, undefined, signal ? { signal } : undefined).catch(() => {
    throw new CancelledError();
  });
}

const HINTS: Partial<Record<ProviderError["kind"], string>> = {
  quota: "add credits or raise the spend limit in the provider's console",
  auth: "check the key with `ccli auth test`",
  config: "check the model name with `ccli models` and `ccli doctor`",
  network: "check your connection or proxy settings",
};

function allFailedError(attempts: AttemptLog[]): CliError {
  const lastByProvider = new Map<ProviderId, AttemptLog>();
  for (const a of attempts) lastByProvider.set(a.provider, a);
  const lines = [...lastByProvider.values()].map((a) => {
    const hint = a.kind ? HINTS[a.kind] : undefined;
    return `  • ${PROVIDERS[a.provider].displayName}: ${a.message ?? "failed"}${hint ? ` — ${hint}` : ""}`;
  });
  return new CliError(
    `Every configured AI provider failed:\n${lines.join("\n") || "  (no provider was tried)"}`,
    {
      hint: "Nothing was committed. You can write the message yourself with `ccli commit`.",
    },
  );
}

function budgetError(budgetMs: number, attempts: AttemptLog[]): CliError {
  const tried =
    [...new Set(attempts.map((a) => PROVIDERS[a.provider].displayName))].join(", ") || "none";
  return new CliError(
    `Gave up after ${Math.round(budgetMs / 1000)} s (providers tried: ${tried}).`,
    {
      hint: "Raise smart.requestBudgetMs, lower the effort level, or try again later.",
    },
  );
}
