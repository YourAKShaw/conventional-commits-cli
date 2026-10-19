import process from "node:process";
import { credentialsPath } from "../config/paths.js";
import { PROVIDERS } from "../providers/registry.js";
import type { ProviderId } from "../providers/types.js";
import { debug } from "../term.js";
import { FileStore } from "./filestore.js";
import { createKeychain, type Keychain } from "./keychain.js";

export type KeySource = "env" | "keychain" | "file";

export interface ResolvedKey {
  value: string;
  source: KeySource;
  /** Environment variable or store the key came from, for display. */
  origin: string;
}

export interface KeyStore {
  resolve(provider: ProviderId): Promise<ResolvedKey | null>;
  keychain: Keychain;
  file: FileStore;
}

/** Resolution order: environment variable → OS keychain → opt-in plaintext file. */
export function createKeyStore(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const keychain = createKeychain(env);
  const file = new FileStore(credentialsPath(env));
  return {
    keychain,
    file,
    async resolve(provider) {
      for (const name of PROVIDERS[provider].envVars) {
        const value = env[name]?.trim();
        if (value) return { value, source: "env", origin: name };
      }
      try {
        const value = (await keychain.get(provider))?.trim();
        if (value) return { value, source: "keychain", origin: "OS keychain" };
      } catch (error) {
        debug(`keychain lookup for ${provider} skipped: ${(error as Error).message}`);
      }
      const fromFile = file.get(provider)?.trim();
      if (fromFile) return { value: fromFile, source: "file", origin: file.location };
      return null;
    },
  };
}

/** "…wxyz" — enough to tell keys apart, never enough to use one. */
export function maskKey(value: string): string {
  return value.length <= 8 ? "****" : `…${value.slice(-4)}`;
}
