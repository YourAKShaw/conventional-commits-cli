import picomatch from "picomatch";
import type { FileChange } from "../git/diff.js";
import { git, splitNul } from "../git/git.js";
import type { RepoInfo } from "../git/repo.js";
import type { PathPolicy } from "../guard/denylist.js";

export type SummaryReason =
  | "sensitive file"
  | "possible secret"
  | "binary"
  | "lockfile"
  | "generated"
  | "deleted"
  | "too large to capture";

const LOCKFILES = picomatch(
  [
    "**/package-lock.json",
    "**/npm-shrinkwrap.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lock",
    "**/bun.lockb",
    "**/deno.lock",
    "**/Cargo.lock",
    "**/Gemfile.lock",
    "**/poetry.lock",
    "**/uv.lock",
    "**/Pipfile.lock",
    "**/composer.lock",
    "**/go.sum",
    "**/flake.lock",
    "**/mix.lock",
    "**/Podfile.lock",
    "**/pubspec.lock",
    "**/packages.lock.json",
    "**/gradle.lockfile",
  ],
  { dot: true },
);

const GENERATED = picomatch(
  [
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/node_modules/**",
    "**/vendor/**",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.map",
    "**/*.bundle.js",
    "**/*.pb.go",
    "**/*_pb2.py",
    "**/*.generated.*",
  ],
  { dot: true },
);

/** Decide which files are sent as diffs and which only as a one-line summary. */
export function classifyFile(
  file: FileChange,
  policy: PathPolicy,
  generatedByAttributes: ReadonlySet<string>,
): SummaryReason | null {
  if (policy.isDenied(file.path) || (file.oldPath && policy.isDenied(file.oldPath)))
    return "sensitive file";
  if (file.binary) return "binary";
  if (file.patchMissing) return "too large to capture";
  if (LOCKFILES(file.path)) return "lockfile";
  if (GENERATED(file.path) || generatedByAttributes.has(file.path)) return "generated";
  if (file.status === "D") return "deleted";
  return null;
}

/** Paths marked `linguist-generated` in .gitattributes. */
export async function generatedPaths(
  repo: RepoInfo,
  paths: readonly string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (paths.length === 0) return result;
  const out = await git(["check-attr", "-z", "--stdin", "linguist-generated"], {
    cwd: repo.root,
    input: `${paths.join("\0")}\0`,
    allowFailure: true,
  });
  if (out.code !== 0) return result;
  const fields = splitNul(out.stdout);
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const value = fields[i + 2];
    if (value === "set" || value === "true") result.add(fields[i] ?? "");
  }
  return result;
}
