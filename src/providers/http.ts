import { debug } from "../term.js";
import { classifyHttpError } from "./classify.js";
import { type CallSettings, ProviderError, type ProviderId } from "./types.js";

export interface JsonResponse {
  status: number;
  json: unknown;
  requestId: string | undefined;
  latencyMs: number;
}

/**
 * POST JSON with a timeout and the caller's cancellation signal. Non-2xx responses are
 * classified into ProviderError kinds. Request bodies and headers are never logged.
 */
export async function postJson(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  settings: CallSettings,
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = settings.signal ? AbortSignal.any([settings.signal, timeout]) : timeout;
  const doFetch = settings.fetch ?? fetch;
  const started = Date.now();

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (settings.signal?.aborted)
      throw new ProviderError(provider, "cancelled", "Request cancelled.");
    if (timeout.aborted) {
      throw new ProviderError(
        provider,
        "timeout",
        `No response within ${Math.round(settings.timeoutMs / 1000)} s.`,
      );
    }
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new ProviderError(
      provider,
      "network",
      `Network error${cause ? ` (${cause})` : ""}: ${(error as Error).message}`,
    );
  }

  const requestId =
    response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (settings.signal?.aborted)
      throw new ProviderError(provider, "cancelled", "Request cancelled.");
    if (timeout.aborted)
      throw new ProviderError(provider, "timeout", "Timed out while reading the response.");
    throw new ProviderError(provider, "network", `Connection dropped: ${(error as Error).message}`);
  }
  const latencyMs = Date.now() - started;
  const json = safeJson(text);
  debug(
    `${provider} POST ${new URL(url).pathname} → ${response.status} in ${latencyMs} ms${requestId ? ` (request ${requestId})` : ""}`,
  );

  if (!response.ok) {
    throw classifyHttpError(provider, response.status, json ?? text, {
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      hasRetryAfter: response.headers.has("retry-after"),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (json === undefined) {
    throw new ProviderError(provider, "invalid_response", "The response was not valid JSON.", {
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  return { status: response.status, json, requestId, latencyMs };
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
