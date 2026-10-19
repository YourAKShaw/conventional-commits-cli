import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowedScopes,
  allowedTypes,
  headerLimit,
  loadLintConfig,
  runCommitlint,
} from "../../src/message/commitlint.js";
import { validateMessage } from "../../src/message/validate.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ccli-lint-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const options = { types: "commitlint" as const, headerMaxLength: 72, loadJsConfig: false };

describe("loadLintConfig", () => {
  it("uses @commitlint/config-conventional with ccli's header limit", async () => {
    const cfg = await loadLintConfig(tempDir(), options);
    expect(cfg.source).toBe("conventional-defaults");
    expect(headerLimit(cfg, 0)).toBe(72);
    expect(allowedTypes(cfg).map((t) => t.type)).toContain("feat");
    expect(allowedTypes(cfg).find((t) => t.type === "fix")?.description).toBe("A bug fix");
  });

  it("applies explicit ccli types", async () => {
    const cfg = await loadLintConfig(tempDir(), {
      ...options,
      types: [{ type: "feature", description: "New" }],
    });
    expect(allowedTypes(cfg)).toEqual([{ type: "feature", description: "New" }]);
  });

  it("reads JSON commitlint rules from the repository", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".commitlintrc.json"),
      JSON.stringify({
        extends: ["@commitlint/config-conventional"],
        rules: {
          "scope-enum": [2, "always", ["api", "cli"]],
          "header-max-length": [2, "always", 50],
        },
      }),
    );
    const cfg = await loadLintConfig(dir, options);
    expect(cfg.source).toBe("repo-json");
    expect(allowedScopes(cfg)).toEqual(["api", "cli"]);
    expect(headerLimit(cfg, 72)).toBe(50);
    expect(cfg.notes).toEqual([]);
  });

  it("reads the commitlint field in package.json and notes unsupported extends", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        commitlint: {
          extends: ["@company/config"],
          rules: { "type-enum": [2, "always", ["feat", "fix"]] },
        },
      }),
    );
    const cfg = await loadLintConfig(dir, options);
    expect(allowedTypes(cfg).map((t) => t.type)).toEqual(["feat", "fix"]);
    expect(cfg.notes.join(" ")).toMatch(/@company\/config/);
  });

  it("does not execute JavaScript configs unless allowed", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "commitlint.config.js"), "throw new Error('should not run')");
    const cfg = await loadLintConfig(dir, options);
    expect(cfg.source).toBe("conventional-defaults");
    expect(cfg.notes.join(" ")).toMatch(/not executed/);
  });
});

describe("runCommitlint / validateMessage", () => {
  it("accepts emoji subjects and flags style problems", async () => {
    const cfg = await loadLintConfig(tempDir(), options);
    expect(await runCommitlint("feat(api): ✨ add endpoint", cfg)).toEqual([]);
    const issues = await runCommitlint("Feat: Add endpoint.", cfg);
    expect(issues.map((i) => i.rule)).toEqual(
      expect.arrayContaining(["type-case", "subject-full-stop", "type-enum"]),
    );
  });

  it("ignores a prefix-position gitmoji when linting", async () => {
    const cfg = await loadLintConfig(tempDir(), options);
    expect(await runCommitlint("✨ feat: add endpoint", cfg)).toEqual([]);
  });

  it("separates spec errors (blocking) from style errors", async () => {
    const cfg = await loadLintConfig(tempDir(), options);
    const spec = await validateMessage("feat:missing space", cfg);
    expect(spec.specErrors.length).toBeGreaterThan(0);
    expect(spec.styleErrors).toEqual([]);
    const style = await validateMessage(`feat: ${"x".repeat(80)}`, cfg);
    expect(style.specErrors).toEqual([]);
    expect(style.styleErrors.map((i) => i.rule)).toContain("header-max-length");
  });
});
