import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { TOOL_NAME } from "../meta.js";

/**
 * Per-user configuration directory:
 *   CCLI_CONFIG_DIR (override) → $XDG_CONFIG_HOME → platform default
 *   Windows: %APPDATA%\conventional-commits-cli
 *   macOS:   ~/Library/Application Support/conventional-commits-cli
 *   Linux/other: ~/.config/conventional-commits-cli
 */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.CCLI_CONFIG_DIR) return env.CCLI_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, TOOL_NAME);
  const home = homedir();
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), TOOL_NAME);
  if (platform === "darwin") return join(home, "Library", "Application Support", TOOL_NAME);
  return join(home, ".config", TOOL_NAME);
}

/** Per-user cache directory (provider state). Safe to delete at any time. */
export function cacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.CCLI_CACHE_DIR) return env.CCLI_CACHE_DIR;
  if (env.CCLI_CONFIG_DIR) return join(env.CCLI_CONFIG_DIR, "cache");
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, TOOL_NAME);
  const home = homedir();
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), TOOL_NAME, "Cache");
  if (platform === "darwin") return join(home, "Library", "Caches", TOOL_NAME);
  return join(home, ".cache", TOOL_NAME);
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}
