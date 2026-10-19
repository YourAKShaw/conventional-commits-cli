export const PROVIDER_IDS = ["openai", "anthropic", "xai", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface GenerateRequest {
  system: string;
  user: string;
  /** JSON Schema for the response object. */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Ask the provider to enforce the schema (structured outputs). */
  structured: boolean;
}

export interface CallSettings {
  apiKey: string;
  model: string;
  /** Provider-native effort value, or null to omit the parameter. */
  effort: string | null;
  maxOutputTokens: number;
  timeoutMs: number;
  baseUrl: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  requestId?: string;
  latencyMs: number;
}

export type ErrorKind =
  /** Credits, quota or spend limit exhausted: retrying will not help, fall back. */
  | "quota"
  /** Temporary throttling. */
  | "rate_limit"
  | "overloaded"
  | "auth"
  /** Invalid model, parameter or request shape. */
  | "config"
  /** Output cut off by the token limit. */
  | "truncated"
  | "refusal"
  | "network"
  | "timeout"
  | "invalid_response"
  | "cancelled";

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly provider: ProviderId;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  /** Quota classification inferred from indirect signals (shorter exhausted-cache TTL). */
  readonly heuristic: boolean;

  constructor(
    provider: ProviderId,
    kind: ErrorKind,
    message: string,
    details: {
      status?: number;
      code?: string;
      retryAfterMs?: number;
      requestId?: string;
      heuristic?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.requestId = details.requestId;
    this.heuristic = details.heuristic ?? false;
  }
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  defaultBaseUrl: string;
  generate(request: GenerateRequest, settings: CallSettings): Promise<GenerateResult>;
}
