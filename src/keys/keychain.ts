import process from "node:process";
import { KEYCHAIN_SERVICE } from "../meta.js";
import { debug } from "../term.js";

export interface Keychain {
  /** Whether the OS keychain can be used here, and why not. */
  availability(): Promise<{ available: boolean; reason?: string }>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

const TIMEOUT_MS = 5_000;

type AsyncEntryCtor = new (
  service: string,
  username: string,
  options?: { linux?: { store?: "secret-service" | "keyutils" } },
) => {
  getPassword(signal?: AbortSignal): Promise<string | null>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
};

/**
 * OS keychain via the optional @napi-rs/keyring module (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service). Linux entries are pinned to Secret Service so keys are never
 * silently stored in the non-persistent kernel keyring. Calls run off the main thread and are
 * bounded by a timeout so a missing or locked keyring cannot hang the CLI.
 */
export function createKeychain(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Keychain {
  let modulePromise: Promise<AsyncEntryCtor | null> | null = null;

  const unavailableReason = (): string | undefined => {
    if (env.CCLI_DISABLE_KEYCHAIN === "1") return "disabled by CCLI_DISABLE_KEYCHAIN=1";
    if (platform === "linux" && !env.DBUS_SESSION_BUS_ADDRESS) {
      return "no D-Bus session (Secret Service is unreachable, common over SSH, in containers and CI)";
    }
    return undefined;
  };

  const load = () => {
    modulePromise ??= import("@napi-rs/keyring")
      .then((m) => (m as { AsyncEntry?: AsyncEntryCtor }).AsyncEntry ?? null)
      .catch((error: unknown) => {
        debug(`@napi-rs/keyring unavailable: ${(error as Error).message}`);
        return null;
      });
    return modulePromise;
  };

  const entry = async (account: string) => {
    const reason = unavailableReason();
    if (reason) throw new Error(`OS keychain unavailable: ${reason}`);
    const AsyncEntry = await load();
    if (!AsyncEntry)
      throw new Error(
        "OS keychain unavailable: the native keyring module is not installed for this platform",
      );
    return new AsyncEntry(KEYCHAIN_SERVICE, account, { linux: { store: "secret-service" } });
  };

  return {
    async availability() {
      const reason = unavailableReason();
      if (reason) return { available: false, reason };
      const AsyncEntry = await load();
      if (!AsyncEntry)
        return {
          available: false,
          reason: "the native keyring module is not installed for this platform",
        };
      return { available: true };
    },
    async get(account) {
      const e = await entry(account);
      return withTimeout((signal) => e.getPassword(signal), "read");
    },
    async set(account, secret) {
      const e = await entry(account);
      await withTimeout((signal) => e.setPassword(secret, signal), "write");
    },
    async delete(account) {
      const e = await entry(account);
      return withTimeout((signal) => e.deleteCredential(signal), "delete");
    },
  };
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  action: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `OS keychain ${action} timed out after ${TIMEOUT_MS / 1000} s (is the keyring locked?)`,
        ),
      );
    }, TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
