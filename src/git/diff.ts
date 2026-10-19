import { createHash } from "node:crypto";
import { git, splitNul } from "./git.js";
import type { RepoInfo } from "./repo.js";

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  hunks: Hunk[];
  /** True when the patch for this file was not captured (output limit reached). */
  patchMissing: boolean;
}

export interface StagedChanges {
  files: FileChange[];
  /** Patch output exceeded the capture limit; some files have no hunks. */
  truncated: boolean;
}

// Options shared by every diff invocation so that file order and rename detection agree.
// --no-ext-diff / --no-textconv stop repository-configured drivers from running;
// explicit prefixes and --no-relative neutralise diff.noprefix / diff.relative settings.
const DIFF_BASE = ["diff", "--cached", "--find-renames", "--no-ext-diff", "--no-relative"];

const MAX_PATCH_BYTES = 32 * 1024 * 1024;

export async function getStagedChanges(repo: RepoInfo): Promise<StagedChanges> {
  const [nameStatus, numstat, patch] = await Promise.all([
    git([...DIFF_BASE, "-z", "--name-status"], { cwd: repo.root }),
    git([...DIFF_BASE, "-z", "--numstat"], { cwd: repo.root }),
    git(
      [...DIFF_BASE, "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-U3"],
      { cwd: repo.root, maxBytes: MAX_PATCH_BYTES },
    ),
  ]);

  const files = parseNameStatus(nameStatus.stdout);
  applyNumstat(files, parseNumstat(numstat.stdout));
  const sections = splitPatch(patch.stdout);

  // git emits files in the same order for identical options. If the counts disagree
  // (for example the patch was truncated), only the captured prefix is matched.
  files.forEach((file, i) => {
    const section = sections[i];
    if (section === undefined || (patch.truncated && i === sections.length - 1)) {
      file.patchMissing = true;
      return;
    }
    const parsed = parsePatchSection(section);
    file.hunks = parsed.hunks;
    if (parsed.binary) file.binary = true;
  });

  return { files, truncated: patch.truncated };
}

export function parseNameStatus(text: string): FileChange[] {
  const fields = splitNul(text);
  const files: FileChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i] ?? "";
    const letter = (code[0] ?? "M") as ChangeStatus;
    if (letter === "R" || letter === "C") {
      const oldPath = fields[++i] ?? "";
      const path = fields[++i] ?? "";
      files.push(blank(path, letter, oldPath));
    } else {
      const path = fields[++i] ?? "";
      files.push(blank(path, letter));
    }
  }
  return files;
}

interface NumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
}

export function parseNumstat(text: string): NumstatEntry[] {
  const fields = splitNul(text);
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? "";
    const [a = "-", d = "-", inlinePath = ""] = record.split("\t");
    let path = inlinePath;
    // Renames with -z: "added\tdeleted\t" followed by old and new paths as separate fields.
    if (inlinePath === "") {
      i += 1;
      path = fields[++i] ?? "";
    }
    entries.push({
      path,
      added: a === "-" ? null : Number(a),
      deleted: d === "-" ? null : Number(d),
    });
  }
  return entries;
}

function applyNumstat(files: FileChange[], entries: NumstatEntry[]): void {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry) continue;
    file.added = entry.added;
    file.deleted = entry.deleted;
    if (entry.added === null && entry.deleted === null) file.binary = true;
  }
}

export function splitPatch(text: string): string[] {
  if (!text) return [];
  const sections: string[] = [];
  const lines = text.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatchSection(section: string): { hunks: Hunk[]; binary: boolean } {
  const hunks: Hunk[] = [];
  let binary = false;
  let current: Hunk | null = null;
  for (const raw of section.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = HUNK_RE.exec(line);
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        newStart: Number(match[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
      continue;
    }
    if (line === "" && raw === "") continue;
    current.lines.push(line);
  }
  return { hunks, binary };
}

/**
 * Fingerprint of the staged tree relative to HEAD. Changes whenever the index changes,
 * without writing objects to the repository.
 */
export async function stagedFingerprint(repo: RepoInfo): Promise<string> {
  const raw = await git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff"], {
    cwd: repo.root,
  });
  return createHash("sha256").update(raw.stdout).digest("hex");
}

function blank(path: string, status: ChangeStatus, oldPath?: string): FileChange {
  const file: FileChange = {
    path,
    status,
    added: null,
    deleted: null,
    binary: false,
    hunks: [],
    patchMissing: false,
  };
  if (oldPath !== undefined) file.oldPath = oldPath;
  return file;
}
