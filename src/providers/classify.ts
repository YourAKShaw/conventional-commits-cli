import { type ErrorKind, ProviderError, type ProviderId } from "./types.js";

interface ErrorInfo {
  message: string;
  type?: string;
  code?: string;
}

export interface HttpErrorContext {
  retryAfterMs?: number;
  hasRetryAfter: boolean;
  requestId?: string;
}

// Sources (checked 2026-10-17):
//  OpenAI     https://developers.openai.com/api/docs/guides/error-codes
//  Anthropic  https://platform.claude.com/docs/en/api/errors
//  Gemini     https://ai.google.dev/gemini-api/docs/api-errors
//  xAI        https://docs.x.ai/developers/debugging (no dedicated out-of-credits code is documented)
const OPENAI_QUOTA_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

const QUOTA_WORDS =
  /credit|billing|spend(ing)? limit|quota|exhausted|insufficient|payment|balance/i;

/** Map an HTTP error response to a ProviderError kind that drives retry and fallback. */
export function classifyHttpError(
  provider: ProviderId,
  status: number,
  body: unknown,
  context: HttpErrorContext,
): ProviderError {
  const info = extractError(body);
  const code = info.code ?? info.type;
  const detail = `${status}${code ? ` ${code}` : ""}`;
  const make = (kind: ErrorKind, message: string, heuristic = false) =>
    new ProviderError(provider, kind, `${message} (${detail})`, {
      status,
      ...(code === undefined ? {} : { code }),
      ...(context.retryAfterMs === undefined ? {} : { retryAfterMs: context.retryAfterMs }),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      heuristic,
    });
  const said = info.message ? `: ${truncate(info.message)}` : "";

  switch (provider) {
    case "openai":
      if (
        status === 429 &&
        (OPENAI_QUOTA_CODES.has(info.code ?? "") || info.type === "insufficient_quota")
      ) {
        return make("quota", `Credits or spend limit exhausted${said}`);
      }
      if (status === 429) return make("rate_limit", `Rate limited${said}`);
      break;
    case "anthropic":
      if (status === 402 || info.type === "billing_error")
        return make("quota", `Billing problem or no credits${said}`);
      if (status === 400 && QUOTA_WORDS.test(info.message))
        return make("quota", `Spend limit reached${said}`);
      if (status === 429 && !context.hasRetryAfter) {
        // A usage-tier spend cap returns 429 without retry-after and keeps failing until access resumes.
        return make("quota", `Usage cap reached${said}`, true);
      }
      if (status === 529 || info.type === "overloaded_error")
        return make("overloaded", `Overloaded${said}`);
      break;
    case "gemini":
      if (status === 402 || info.code === "payment_required")
        return make("quota", `Prepaid credits depleted${said}`);
      if (info.code === "quota_exceeded") return make("quota", `Daily quota exceeded${said}`);
      if (info.code === "failed_precondition")
        return make("quota", `Account prerequisite not met (billing?)${said}`);
      if (info.code === "model_not_found") return make("config", `Model not found${said}`);
      if (
        status === 429 &&
        /RESOURCE_EXHAUSTED/i.test(info.type ?? "") &&
        /quota/i.test(info.message)
      ) {
        return make("quota", `Quota exceeded${said}`, true);
      }
      break;
    case "xai":
      if (status === 402) return make("quota", `Out of credits${said}`);
      if ((status === 403 || status === 429) && QUOTA_WORDS.test(info.message)) {
        return make("quota", `Credits or spending limit reached${said}`, true);
      }
      break;
  }

  if (status === 401) return make("auth", `API key rejected${said}`);
  if (status === 403) return make("auth", `Permission denied${said}`);
  if (status === 408) return make("timeout", `Request timed out${said}`);
  if (status === 429) return make("rate_limit", `Rate limited${said}`);
  if (status === 404) return make("config", `Not found — check the model name and base URL${said}`);
  if (status >= 500) return make("overloaded", `Server error${said}`);
  if (status >= 400) return make("config", `Request rejected${said}`);
  return make("invalid_response", `Unexpected status${said}`);
}

/** Pull message/type/code out of the error shapes used by the four providers. */
export function extractError(body: unknown): ErrorInfo {
  if (typeof body === "string") return { message: body };
  if (!body || typeof body !== "object") return { message: "" };
  const obj = body as Record<string, unknown>;
  const err = obj.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const info: ErrorInfo = { message: typeof e.message === "string" ? e.message : "" };
    if (typeof e.type === "string") info.type = e.type;
    else if (typeof e.status === "string") info.type = e.status;
    if (typeof e.code === "string") info.code = e.code;
    return info;
  }
  if (typeof err === "string") {
    const info: ErrorInfo = { message: err };
    if (typeof obj.code === "string") info.code = obj.code;
    return info;
  }
  return { message: typeof obj.message === "string" ? obj.message : "" };
}

function truncate(text: string, max = 200): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
