import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { cacheDir } from "../config/paths.js";
import type { ProviderId } from "../providers/types.js";

export interface ProviderState {
  /** Epoch ms until which the provider is assumed to have no credits/quota. */
  isExhausted(provider: ProviderId, now?: number): boolean;
  markExhausted(provider: ProviderId, ttlMs: number, reason: string, now?: number): void;
  clear(provider: ProviderId): void;
}

export const EXHAUSTED_TTL_MS = 30 * 60 * 1000;
export const HEURISTIC_EXHAUSTED_TTL_MS = 5 * 60 * 1000;

type StateFile = Partial<Record<ProviderId, { exhaustedUntil: number; reason: string }>>;

/** Small best-effort cache so a provider out of credits is skipped for a while. */
export function createProviderState(env: NodeJS.ProcessEnv = process.env): ProviderState {
  const path = join(cacheDir(env), "provider-state.json");
  const read = (): StateFile => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StateFile;
    } catch {
      return {};
    }
  };
  const write = (data: StateFile) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data), "utf8");
    } catch {
      // The cache is an optimisation; failing to write it is harmless.
    }
  };
  return {
    isExhausted(provider, now = Date.now()) {
      return (read()[provider]?.exhaustedUntil ?? 0) > now;
    },
    markExhausted(provider, ttlMs, reason, now = Date.now()) {
      write({ ...read(), [provider]: { exhaustedUntil: now + ttlMs, reason } });
    },
    clear(provider) {
      const data = read();
      if (data[provider]) {
        delete data[provider];
        write(data);
      }
    },
  };
}

export function memoryProviderState(): ProviderState {
  const data = new Map<ProviderId, number>();
  return {
    isExhausted: (p, now = Date.now()) => (data.get(p) ?? 0) > now,
    markExhausted: (p, ttl, _reason, now = Date.now()) => void data.set(p, now + ttl),
    clear: (p) => void data.delete(p),
  };
}
