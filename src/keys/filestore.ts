import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { CliError } from "../errors.js";
import type { ProviderId } from "../providers/types.js";

interface CredentialsFile {
  version: 1;
  keys: Partial<Record<ProviderId, string>>;
}

/**
 * Plaintext fallback store, used only after an explicit --insecure-file-store opt-in.
 * The file is created with owner-only permissions (0600) on POSIX systems; on Windows it
 * relies on the per-user profile directory's ACLs.
 */
export class FileStore {
  constructor(private readonly path: string) {}

  get location(): string {
    return this.path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  get(provider: ProviderId): string | null {
    return this.read().keys[provider] ?? null;
  }

  set(provider: ProviderId, secret: string): void {
    const data = this.read();
    data.keys[provider] = secret;
    this.write(data);
  }

  delete(provider: ProviderId): boolean {
    const data = this.read();
    if (!(provider in data.keys)) return false;
    delete data.keys[provider];
    this.write(data);
    return true;
  }

  /** Warning when the file is readable by other users (POSIX only). */
  permissionWarning(): string | null {
    if (process.platform === "win32" || !this.exists()) return null;
    const mode = statSync(this.path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${this.path} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${this.path}"`;
    }
    return null;
  }

  private read(): CredentialsFile {
    if (!this.exists()) return { version: 1, keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialsFile>;
      return { version: 1, keys: { ...(parsed.keys ?? {}) } };
    } catch (error) {
      throw new CliError(`${this.path} is not valid JSON: ${(error as Error).message}`);
    }
  }

  private write(data: CredentialsFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }
}
