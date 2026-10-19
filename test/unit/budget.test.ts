import { describe, expect, it } from "vitest";
import { buildPayload, estimateTokens } from "../../src/diff/budget.js";
import type { FileChange, Hunk } from "../../src/git/diff.js";

const hunk = (lines: string[], start = 1): Hunk => ({
  header: `@@ -${start},1 +${start},${lines.length} @@`,
  oldStart: start,
  newStart: start,
  lines,
});
const file = (path: string, lines: string[], extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  added: lines.length,
  deleted: 0,
  binary: false,
  hunks: [hunk(lines)],
  patchMissing: false,
  ...extra,
});
const big = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i} ${"x".repeat(60)}`);

describe("buildPayload", () => {
  it("includes everything when it fits", () => {
    const p = buildPayload([file("a.ts", ["+a"]), file("b.ts", ["-b", "+c"])], () => null, {
      maxDiffTokens: 1000,
    });
    expect(p.files.map((f) => f.mode)).toEqual(["full", "full"]);
    expect(p.truncated).toBe(false);
    expect(p.files[1]?.lineRefs).toEqual(["hunk at line 1", "removed line 1", "line 1"]);
  });

  it("serves small files whole and truncates the large one (water-filling)", () => {
    const p = buildPayload([file("small.ts", ["+tiny"]), file("huge.ts", big(500))], () => null, {
      maxDiffTokens: 600,
    });
    const [small, huge] = p.files;
    expect(small?.mode).toBe("full");
    expect(huge?.mode).toBe("partial");
    expect(huge?.omittedLines).toBeGreaterThan(0);
    expect(p.truncated).toBe(true);
    expect(p.diffTokens).toBeLessThanOrEqual(600);
  });

  it("lists summary-only files with their reason", () => {
    const p = buildPayload(
      [file("yarn.lock", ["+x"]), file("a.ts", ["+y"])],
      (f) => (f.path === "yarn.lock" ? "lockfile" : null),
      {
        maxDiffTokens: 1000,
      },
    );
    expect(p.files[0]).toMatchObject({ mode: "summary", reason: "lockfile", text: "" });
  });

  it("omits files whose share is too small to be useful", () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`f${i}.ts`, big(50)));
    const p = buildPayload(files, () => null, { maxDiffTokens: 1000 });
    expect(p.files.some((f) => f.reason === "budget")).toBe(true);
  });

  it("truncates very long lines and flags large changes", () => {
    const p = buildPayload([file("min.js", [`+${"y".repeat(2000)}`])], () => null, {
      maxDiffTokens: 5000,
      largeChangeLines: 0,
    });
    expect(p.files[0]?.text).toContain("…[line truncated]");
    expect(p.large).toBe(true);
  });

  it("estimates tokens conservatively", () => {
    expect(estimateTokens("abcd")).toBe(2);
  });
});
