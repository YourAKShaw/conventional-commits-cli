import { modelInfo } from "./registry.js";
import type { ProviderId } from "./types.js";

/** Union of effort names across providers, lowest to highest. */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface EffortResolution {
  /** Value to send, or null to omit the parameter (vendor default). */
  value: string | null;
  warning?: string;
}

/**
 * Resolve the configured effort for a model. "auto" omits the parameter. A value the model
 * does not support is lowered to the nearest supported level (or the lowest one), with a warning.
 */
export function resolveEffort(
  provider: ProviderId,
  model: string,
  requested: string | undefined,
): EffortResolution {
  if (!requested || requested === "auto") return { value: null };
  const wanted = requested.toLowerCase();
  const info = modelInfo(provider, model);
  if (!info?.efforts) return { value: wanted };
  if (info.efforts.includes(wanted)) return { value: wanted };

  const rank = EFFORT_SCALE.indexOf(wanted as (typeof EFFORT_SCALE)[number]);
  const supported = [...info.efforts].sort(
    (a, b) => EFFORT_SCALE.indexOf(a as never) - EFFORT_SCALE.indexOf(b as never),
  );
  const lower =
    rank === -1 ? [] : supported.filter((e) => EFFORT_SCALE.indexOf(e as never) <= rank);
  const chosen = lower[lower.length - 1] ?? supported[0] ?? null;
  return {
    value: chosen,
    warning: `${model} does not support effort "${requested}"; using "${chosen}". Supported: ${info.efforts.join(", ")}.`,
  };
}
