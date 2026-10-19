import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CliError, ExitCode } from "../errors.js";
import { type GlobalConfig, globalConfigSchema } from "./schema.js";

const SCHEMA_URL =
  "https://raw.githubusercontent.com/YourAKShaw/conventional-commits-cli/main/schema/config.schema.json";

/** Parse a CLI value: JSON when it parses (true, 5, ["a"]), a comma list for arrays, else a string. */
export function parseValue(key: string, raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    if (
      /(^|\.)(order|acknowledgedProviders|scopes|types|extraDenyGlobs|extraPatterns)$/.test(key)
    ) {
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return trimmed;
  }
}

export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export function getPath(obj: Record<string, unknown>, key: string): unknown {
  let current: unknown = obj;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    if (part === "__proto__" || part === "constructor" || part === "prototype")
      throw new CliError(`Invalid key: ${key}`);
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

/** Validate and atomically write the global config. */
export function writeGlobalConfig(path: string, config: Record<string, unknown>): GlobalConfig {
  const withSchema = { $schema: SCHEMA_URL, version: 1, ...config };
  pruneEmpty(withSchema);
  const result = globalConfigSchema.safeParse(withSchema);
  if (!result.success) {
    throw new CliError(
      `That change would make the configuration invalid:\n${z.prettifyError(result.error)}`,
      {
        exitCode: ExitCode.Usage,
      },
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(withSchema, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return result.data;
}

export function updateGlobalConfig(
  path: string,
  mutate: (config: Record<string, unknown>) => void,
): GlobalConfig {
  const config = readRawConfig(path);
  mutate(config);
  return writeGlobalConfig(path, config);
}

function pruneEmpty(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      pruneEmpty(value as Record<string, unknown>);
      if (Object.keys(value).length === 0) delete obj[key];
    }
  }
}
