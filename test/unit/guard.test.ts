import { describe, expect, it } from "vitest";
import { createPathPolicy, toGlob } from "../../src/guard/denylist.js";
import { compileUserPatterns, findHighEntropy, shannonEntropy } from "../../src/guard/patterns.js";
import { mask, redact, scanForSecrets } from "../../src/guard/scan.js";
import { FAKE } from "../helpers/fake-secrets.js";

describe("path policy", () => {
  const policy = createPathPolicy(["config/prod/**"]);
  it.each([
    ".env",
    "apps/web/.env.local",
    "certs/server.pem",
    "deploy/key.p12",
    "home/.ssh/id_ed25519",
    "gcp-credentials.json",
    ".npmrc",
    "infra/terraform.tfstate",
    "infra/prod.tfvars",
    "config/prod/db.yml",
    "SECRETS.YML",
  ])("withholds %s", (path) => expect(policy.isDenied(path)).toBe(true));

  it.each([".env.example", "id_ed25519.pub", "src/env.ts", "docs/keys.md", "package.json"])(
    "allows %s",
    (path) => expect(policy.isDenied(path)).toBe(false),
  );

  it("converts gitignore-style lines to globs", () => {
    expect(toGlob("secret.txt")).toBe("**/secret.txt");
    expect(toGlob("/root-only.txt")).toBe("root-only.txt");
    expect(toGlob("private/")).toBe("**/private/**");
    expect(toGlob("config/*.yml")).toBe("config/*.yml");
  });
});

describe("scanForSecrets", () => {
  it.each(Object.entries(FAKE))("detects %s", async (_name, value) => {
    const findings = await scanForSecrets([{ source: "a.ts", text: `+const value = "${value}";` }]);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("reports location, masks values and merges overlapping detectors", async () => {
    const text = `line one\n+token = "${FAKE.github}"`;
    const findings = await scanForSecrets([
      { source: "x.ts", text, lineRefs: ["line 10", "line 11"] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toBe("line 11");
    expect(findings[0]?.masked).not.toContain(FAKE.github);
    expect(findings[0]?.masked).toMatch(/^ghp_…\*{4} \(\d+ chars\)$/);
  });

  it("ignores inline secretlint-disable comments", async () => {
    const text = `// secretlint-disable\nconst t = "${FAKE.github}";\n// secretlint-enable`;
    expect((await scanForSecrets([{ source: "x.ts", text }])).length).toBeGreaterThan(0);
  });

  it("does not flag ordinary code, hashes, UUIDs or placeholders", async () => {
    const text = [
      "+import { createHash } from 'node:crypto';",
      "+const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';",
      "+const id = '123e4567-e89b-12d3-a456-426614174000';",
      "+const apiKey = process.env.OPENAI_API_KEY;",
      "+const token = 'your_token_here';",
      "+export const VERY_LONG_CONSTANT_NAME_FOR_CONFIGURATION = true;",
      "+const url = 'https://example.com/path/to/resource?query=value';",
    ].join("\n");
    expect(await scanForSecrets([{ source: "x.ts", text }])).toEqual([]);
  });

  it("applies user patterns and reports invalid ones", async () => {
    const { patterns, errors } = compileUserPatterns(["ACME-[0-9]{6}", "(unclosed"]);
    expect(errors).toHaveLength(1);
    const findings = await scanForSecrets([{ source: "x", text: "key ACME-123456" }], {
      extraPatterns: patterns,
      secretlint: false,
    });
    expect(findings.map((f) => f.rule)).toContain("custom-1");
  });

  it("redacts ranges and masks short values", () => {
    expect(redact("a SECRET b", [{ start: 2, end: 8, rule: "r" }])).toBe("a [REDACTED:r] b");
    expect(mask("abc")).toBe("*** (3 chars)");
  });
});

describe("entropy", () => {
  it("computes Shannon entropy", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });

  it("needs a credential keyword unless the token is long and very random", () => {
    expect(findHighEntropy("password = 'Xk9mP2vL8qR4tN6w'")).toHaveLength(1);
    expect(findHighEntropy("value = 'Xk9mP2vL8qR4tN6w'")).toHaveLength(0);
    expect(findHighEntropy(`blob = '${"Zq8Lp3Xv7Nm1Kc5Rt9Wy2Hd6Fg4Bj0Ts"}'`)).toHaveLength(1);
  });
});
