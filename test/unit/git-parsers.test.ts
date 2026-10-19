import { describe, expect, it } from "vitest";
import { validatePassthrough } from "../../src/git/commit.js";
import {
  parseNameStatus,
  parseNumstat,
  parsePatchSection,
  splitPatch,
} from "../../src/git/diff.js";
import { parsePorcelainV2 } from "../../src/git/status.js";

describe("parsePorcelainV2", () => {
  it("parses ordinary, renamed, unmerged and untracked records", () => {
    const text = [
      "1 M. N... 100644 100644 100644 aaa bbb src/a file.ts",
      "1 .M N... 100644 100644 100644 aaa bbb src/b.ts",
      "1 MM N... 100644 100644 100644 aaa bbb both.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts",
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "? notes/ünïcode.md",
      "",
    ].join("\0");
    const s = parsePorcelainV2(text);
    expect(s.staged.map((e) => e.path)).toEqual(["src/a file.ts", "both.ts", "new name.ts"]);
    expect(s.staged[2]?.origPath).toBe("old name.ts");
    expect(s.unstaged.map((e) => e.path)).toEqual(["src/b.ts", "both.ts"]);
    expect(s.unmerged).toEqual(["conflict.ts"]);
    expect(s.untracked).toEqual(["notes/ünïcode.md"]);
  });
});

describe("diff parsing", () => {
  it("parses name-status and numstat with renames and binaries", () => {
    const files = parseNameStatus(
      ["M", "a.ts", "R087", "old.ts", "new.ts", "A", "img.png", ""].join("\0"),
    );
    expect(files.map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ["M", "a.ts", undefined],
      ["R", "new.ts", "old.ts"],
      ["A", "img.png", undefined],
    ]);
    const stats = parseNumstat(
      ["3\t1\ta.ts", "2\t2\t", "old.ts", "new.ts", "-\t-\timg.png", ""].join("\0"),
    );
    expect(stats).toEqual([
      { path: "a.ts", added: 3, deleted: 1 },
      { path: "new.ts", added: 2, deleted: 2 },
      { path: "img.png", added: null, deleted: null },
    ]);
  });

  it("splits a patch into sections and hunks", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@ fn",
      " keep",
      "-old",
      "+new\r",
      "+more",
      "\\ No newline at end of file",
      "diff --git a/b.png b/b.png",
      "Binary files a/b.png and b/b.png differ",
      "",
    ].join("\n");
    const sections = splitPatch(patch);
    expect(sections).toHaveLength(2);
    const first = parsePatchSection(sections[0]!);
    expect(first.hunks).toHaveLength(1);
    expect(first.hunks[0]).toMatchObject({
      oldStart: 1,
      newStart: 1,
      header: "@@ -1,2 +1,3 @@ fn",
    });
    expect(first.hunks[0]?.lines).toEqual([
      " keep",
      "-old",
      "+new",
      "+more",
      "\\ No newline at end of file",
    ]);
    expect(parsePatchSection(sections[1]!).binary).toBe(true);
  });
});

describe("validatePassthrough", () => {
  it.each([
    ["--no-verify"],
    ["-n"],
    ["--signoff"],
    ["-S"],
    ["--author=A <a@b.c>"],
    ["--author", "A <a@b.c>"],
    ["--amend"],
    ["--allow-empty"],
  ])("allows %j", (...args) => expect(() => validatePassthrough(args)).not.toThrow());
  it.each([
    ["-m", "x"],
    ["-mfoo"],
    ["--message=x"],
    ["-F", "f"],
    ["--all"],
    ["-a"],
    ["src/file.ts"],
    ["--dry-run"],
    ["--cleanup=strip"],
    ["-e"],
  ])("rejects %j", (...args) => expect(() => validatePassthrough(args)).toThrow());
});
