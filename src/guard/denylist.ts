import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { REPO_IGNORE_FILE } from "../meta.js";

/**
 * Files whose content is never sent to an AI provider. Their path and line counts are
 * still listed so the model knows something changed.
 */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*.pem",
  "**/*.key",
  "**/*.p8",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.asc",
  "**/*.gpg",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*.kdbx",
  "**/credentials",
  "**/credentials.*",
  "**/*credentials*.json",
  "**/service-account*.json",
  "**/client_secret*.json",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/.dockercfg",
  "**/.docker/config.json",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/kubeconfig*",
  "**/.kube/config",
  "**/secrets.yml",
  "**/secrets.yaml",
  "**/secrets.json",
  "**/*.secret",
  "**/*.secrets",
  "**/.htpasswd",
];

/** Template and public-key files that match the patterns above but are safe to describe. */
export const DEFAULT_ALLOW_GLOBS: readonly string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.dist",
  "**/*.pub",
];

export interface PathPolicy {
  isDenied(path: string): boolean;
  globs: readonly string[];
}

export function createPathPolicy(extraDenyGlobs: readonly string[] = []): PathPolicy {
  const globs = [...DEFAULT_DENY_GLOBS, ...extraDenyGlobs.map(toGlob)];
  const options = { dot: true, nocase: true };
  const deny = picomatch(globs, options);
  const allow = picomatch([...DEFAULT_ALLOW_GLOBS], options);
  return {
    globs,
    isDenied: (path: string) => {
      const p = path.replace(/\\/g, "/");
      if (allow(p) && !extraDenyGlobs.some((g) => picomatch.isMatch(p, toGlob(g), options)))
        return false;
      return deny(p);
    },
  };
}

/** Read `.ccliignore` (gitignore-like globs, one per line, "#" comments). */
export function readIgnoreFile(repoRoot: string): string[] {
  const path = join(repoRoot, REPO_IGNORE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Convert a gitignore-style line to a picomatch glob: patterns without a slash match at
 * any depth, a trailing slash means "everything under this directory".
 */
export function toGlob(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, "/");
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  if (!anchored && !p.includes("/") && !p.startsWith("**")) p = `**/${p}`;
  return dirOnly ? `${p}/**` : p;
}
