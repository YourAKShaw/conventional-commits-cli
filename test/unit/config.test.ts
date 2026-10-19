import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readRepoConfig, resolveConfig } from "../../src/config/load.js";
import { cacheDir, configDir } from "../../src/config/paths.js";
import {
  parseValue,
  readRawConfig,
  setPath,
  updateGlobalConfig,
  writeGlobalConfig,
} from "../../src/config/write.js";
import { FileStore } from "../../src/keys/filestore.js";
import { createKeychain } from "../../src/keys/keychain.js";
import { createKeyStore, maskKey } from "../../src/keys/resolve.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ccli-cfg-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("has safe defaults", () => {
    const c = resolveConfig({}, {});
    expect(c.providers.order).toEqual(["openai", "anthropic", "xai", "gemini"]);
    expect(c.providers.settings.anthropic).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
      maxOutputTokens: 4096,
      structuredOutput: true,
    });
    expect(c.format.gitmoji).toEqual({ enabled: true, style: "unicode", position: "after-colon" });
    expect(c.secrets.onDetect).toBe("ask");
    expect(c.smart.enabled).toBe(true);
  });

  it("lets the repository shape format and tighten egress, never loosen it", () => {
    const c = resolveConfig(
      {
        format: { headerMaxLength: 100, gitmoji: { enabled: true } },
        smart: { maxInputTokens: 20_000 },
        secrets: { extraDenyGlobs: ["a/**"] },
      },
      {
        format: { headerMaxLength: 60, gitmoji: { enabled: false } },
        smart: { enabled: false, maxInputTokens: 30_000 },
        secrets: { extraDenyGlobs: ["b/**"] },
        providers: { allow: ["anthropic"] },
      },
      ["c.txt"],
    );
    expect(c.format.headerMaxLength).toBe(60);
    expect(c.format.gitmoji.enabled).toBe(false);
    expect(c.smart.enabled).toBe(false);
    expect(c.smart.disabledByRepo).toBe(true);
    expect(c.smart.maxInputTokens).toBe(20_000);
    expect(c.secrets.denyGlobs).toEqual(["a/**", "b/**", "c.txt"]);
    expect(c.providers.allow).toEqual(["anthropic"]);
  });

  it("maps explicit type lists", () => {
    const c = resolveConfig(
      { format: { types: ["feat", { type: "fix", description: "Bug" }] } },
      {},
    );
    expect(c.format.types).toEqual([
      { type: "feat", description: "" },
      { type: "fix", description: "Bug" },
    ]);
  });
});

describe("repository config restrictions", () => {
  it.each([
    [{ providers: { order: ["xai"] } }, /provider order/],
    [{ providers: { openai: { baseUrl: "https://evil.example" } } }, /provider settings/],
    [{ smart: { acknowledgedProviders: ["openai"] } }, /data-sharing/],
    [{ secrets: { onDetect: "redact" } }, /secret handling/],
    [{ commitlint: { loadJsConfig: true } }, /executable configs/],
  ])("rejects %j", (json, message) => {
    const dir = temp();
    writeFileSync(join(dir, ".ccli.json"), JSON.stringify(json));
    expect(() => readRepoConfig(join(dir, ".ccli.json"))).toThrow(message);
  });

  it("reports schema errors and invalid JSON with the file path", () => {
    const dir = temp();
    writeFileSync(join(dir, ".ccli.json"), JSON.stringify({ format: { headerMaxLength: 5 } }));
    expect(() => readRepoConfig(join(dir, ".ccli.json"))).toThrow(/headerMaxLength/);
    writeFileSync(join(dir, ".ccli.json"), "{ nope");
    expect(() => readRepoConfig(join(dir, ".ccli.json"))).toThrow(/not valid JSON/);
  });

  it("rejects repository settings that could redirect data, change consent or run code", () => {
    const dir = temp();
    const file = join(dir, ".ccli.json");
    const forbidden: Array<[string, unknown]> = [
      ["providers.order", { providers: { order: ["openai"] } }],
      ["providers.openai", { providers: { openai: { baseUrl: "https://evil.example/v1" } } }],
      ["providers.anthropic", { providers: { anthropic: { model: "claude-opus-5-5" } } }],
      ["providers.xai", { providers: { xai: { enabled: true } } }],
      ["providers.gemini", { providers: { gemini: { effort: "high" } } }],
      ["smart.acknowledgedProviders", { smart: { acknowledgedProviders: ["openai"] } }],
      ["secrets.onDetect", { secrets: { onDetect: "redact" } }],
      ["commitlint", { commitlint: { loadJsConfig: true } }],
    ];
    for (const [key, value] of forbidden) {
      writeFileSync(file, JSON.stringify(value));
      expect(() => readRepoConfig(file), key).toThrow(
        new RegExp(`sets "${key.replace(".", "\\.")}".*cannot control`),
      );
    }
    // Unknown keys are rejected too, so a typo cannot silently weaken a restriction.
    writeFileSync(file, JSON.stringify({ smart: { send: true } }));
    expect(() => readRepoConfig(file)).toThrow(/Invalid repository configuration/);
    // Allowed keys load.
    writeFileSync(
      file,
      JSON.stringify({
        format: { scopes: ["api"] },
        providers: { allow: ["anthropic"] },
        secrets: { extraDenyGlobs: ["x/**"], extraPatterns: ["ACME-[0-9]{8}"] },
        smart: { enabled: true, maxInputTokens: 4000 },
      }),
    );
    expect(readRepoConfig(file).providers?.allow).toEqual(["anthropic"]);
  });

  it("loads repo config and .ccliignore from the repository root", () => {
    const repo = temp();
    const env = { CCLI_CONFIG_DIR: temp() };
    writeFileSync(join(repo, ".ccli.json"), JSON.stringify({ format: { scopes: ["api"] } }));
    writeFileSync(join(repo, ".ccliignore"), "# comment\nfixtures/\n");
    const loaded = loadConfig(repo, env);
    expect(loaded.repoPath).toBe(join(repo, ".ccli.json"));
    expect(loaded.effective.format.scopes).toEqual(["api"]);
    expect(loaded.effective.secrets.denyGlobs).toEqual(["fixtures/"]);
  });
});

describe("config writing", () => {
  it("parses CLI values", () => {
    expect(parseValue("smart.maxRegenerations", "3")).toBe(3);
    expect(parseValue("format.gitmoji.enabled", "false")).toBe(false);
    expect(parseValue("providers.order", "anthropic, openai")).toEqual(["anthropic", "openai"]);
    expect(parseValue("providers.openai.model", "gpt-x")).toBe("gpt-x");
  });

  it("validates before writing and prunes empty objects", () => {
    const path = join(temp(), "nested", "config.json");
    updateGlobalConfig(path, (cfg) => setPath(cfg, "providers.order", ["anthropic"]));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      providers: { order: ["anthropic"] },
    });
    expect(() =>
      updateGlobalConfig(path, (cfg) => setPath(cfg, "providers.order", ["nope"])),
    ).toThrow(/invalid/);
    updateGlobalConfig(path, (cfg) => setPath(cfg, "providers.order", undefined));
    expect(readRawConfig(path)).not.toHaveProperty("providers");
    expect(() => writeGlobalConfig(path, { unknownKey: 1 })).toThrow();
  });

  it("refuses prototype-polluting keys", () => {
    expect(() => setPath({}, "__proto__.x", 1)).toThrow();
  });
});

describe("paths", () => {
  it("follows overrides, XDG and platform conventions", () => {
    expect(configDir({ CCLI_CONFIG_DIR: "/x" })).toBe("/x");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
      join("/xdg", "conventional-commits-cli"),
    );
    expect(configDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toContain(
      "conventional-commits-cli",
    );
    expect(configDir({}, "darwin")).toContain(join("Library", "Application Support"));
    expect(cacheDir({ CCLI_CONFIG_DIR: "/x" })).toBe(join("/x", "cache"));
  });
});

describe("keys", () => {
  it("resolves environment variables first, then the opt-in file store", async () => {
    const dir = temp();
    const store = createKeyStore({
      CCLI_CONFIG_DIR: dir,
      CCLI_DISABLE_KEYCHAIN: "1",
      GOOGLE_API_KEY: "  g-key-1234567890  ",
    });
    expect(await store.resolve("gemini")).toEqual({
      value: "g-key-1234567890",
      source: "env",
      origin: "GOOGLE_API_KEY",
    });
    expect(await store.resolve("openai")).toBeNull();
    store.file.set("openai", "file-key-1234567890");
    expect(await store.resolve("openai")).toMatchObject({
      source: "file",
      value: "file-key-1234567890",
    });
    expect(maskKey("file-key-1234567890")).toBe("…7890");
  });

  it("writes the credentials file with owner-only permissions on POSIX", () => {
    const file = new FileStore(join(temp(), "credentials.json"));
    file.set("xai", "secret-value-123456");
    if (process.platform !== "win32") expect(statSync(file.location).mode & 0o777).toBe(0o600);
    expect(file.permissionWarning()).toBeNull();
    expect(file.delete("xai")).toBe(true);
    expect(file.delete("xai")).toBe(false);
  });

  it("reports why the keychain is unavailable instead of hanging", async () => {
    expect(await createKeychain({ CCLI_DISABLE_KEYCHAIN: "1" }).availability()).toMatchObject({
      available: false,
    });
    const linux = await createKeychain({}, "linux").availability();
    expect(linux).toEqual({ available: false, reason: expect.stringMatching(/D-Bus/) });
    await expect(createKeychain({}, "linux").get("openai")).rejects.toThrow(/unavailable/);
  });
});
