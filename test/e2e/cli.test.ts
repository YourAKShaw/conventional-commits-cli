import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE } from "../helpers/fake-secrets.js";
import { createRepo, type TempRepo } from "../helpers/repo.js";
import { MockProviders, ok } from "./mock-server.js";

const CLI = resolve("dist/cli.js");
const PKG = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, CCLI_CONFIG_DIR: configDir, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

const mock = new MockProviders();
let repo: TempRepo;
let configDir: string;

beforeAll(async () => {
  if (!existsSync(CLI))
    throw new Error(
      "dist/cli.js is missing: run `npm run build` first (npm run test:e2e does this).",
    );
  await mock.start();
});
afterAll(() => mock.stop());
beforeEach(() => {
  repo = createRepo();
  configDir = mkdtempSync(join(tmpdir(), "ccli-e2e-cfg-"));
  mock.requests.length = 0;
});
afterEach(() => repo.cleanup());

function writeConfig(extra: Record<string, unknown> = {}) {
  const providers: Record<string, unknown> = { order: ["openai", "anthropic", "xai", "gemini"] };
  for (const id of ["openai", "anthropic", "xai", "gemini"])
    providers[id] = { baseUrl: mock.baseUrl(id) };
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      providers,
      smart: { acknowledgedProviders: ["openai", "anthropic", "xai", "gemini"] },
      ...extra,
    }),
  );
}
const KEYS = {
  OPENAI_API_KEY: "sk-test-openai-e2e-000000000000",
  ANTHROPIC_API_KEY: "sk-test-anthropic-e2e-0000000000",
  XAI_API_KEY: "xai-test-e2e-00000000000000000",
  GEMINI_API_KEY: "gemini-test-e2e-0000000000000",
};
const stageMath = () => {
  repo.write("math.js", "export const sum = (a, b) => a + b;\n");
  repo.git("add", "math.js");
};

describe("built CLI", () => {
  it("prints its version and help", async () => {
    expect((await run(["--version"], { cwd: repo.root })).stdout.trim()).toBe(PKG.version);
    const help = await run(["--help"], { cwd: repo.root });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("smart commit");
    const bad = await run(["commit", "--nope"], { cwd: repo.root });
    expect(bad.code).toBe(2);
  });

  it("prints a manual message from flags", async () => {
    stageMath();
    const r = await run(["commit", "-t", "feat", "-s", "math", "-m", "add sum helper", "--print"], {
      cwd: repo.root,
    });
    expect(r).toMatchObject({ code: 0, stdout: "feat(math): ✨ add sum helper\n" });
  });

  it("smart --print calls the primary provider with the documented request shape", async () => {
    stageMath();
    writeConfig();
    mock.on("openai", () => ok.openai());
    const r = await run(["smart", "commit", "--print"], { cwd: repo.root, env: KEYS });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "feat(math): ✨ add sum helper\n\nAdds a helper for adding two numbers.\n",
    );
    const req = mock.requests[0]!;
    expect(req.path).toBe("/responses");
    expect(req.headers.authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(req.body).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(JSON.stringify(req.body)).toContain("+export const sum = (a, b) => a + b;");
  });

  it("falls back across providers on quota errors and records nothing secret", async () => {
    repo.write("math.js", `export const sum = (a, b) => a + b;\nconst token = "${FAKE.github}";\n`);
    repo.git("add", "math.js");
    writeConfig();
    mock
      .on("openai", () => ({
        status: 429,
        body: {
          error: {
            code: "credit_balance_exhausted",
            type: "insufficient_quota",
            message: "No credits",
          },
        },
      }))
      .on("anthropic", () => ({
        status: 402,
        body: { type: "error", error: { type: "billing_error", message: "Low balance" } },
      }))
      .on("xai", () => ok.xai());
    const r = await run(["smart", "commit", "--print"], {
      cwd: repo.root,
      env: { ...KEYS, CCLI_CACHE_DIR: join(configDir, "cache") },
    });
    expect(r.code).toBe(0);
    expect(mock.requests.map((q) => q.provider)).toEqual(["openai", "anthropic", "xai"]);
    expect(r.stderr).toMatch(/OpenAI: Credits or spend limit exhausted/);
    expect(r.stderr).toMatch(/Possible secrets/);
    for (const q of mock.requests) expect(JSON.stringify(q.body)).not.toContain(FAKE.github);

    // The exhausted providers are skipped on the next run.
    mock.requests.length = 0;
    const again = await run(["smart", "commit", "--print"], {
      cwd: repo.root,
      env: { ...KEYS, CCLI_CACHE_DIR: join(configDir, "cache") },
    });
    expect(again.code).toBe(0);
    expect(mock.requests.map((q) => q.provider)).toEqual(["xai"]);
  });

  it("talks to Anthropic and Gemini with their documented shapes", async () => {
    stageMath();
    writeConfig({
      providers: {
        order: ["anthropic", "gemini"],
        anthropic: { baseUrl: mock.baseUrl("anthropic") },
        gemini: { baseUrl: mock.baseUrl("gemini") },
      },
    });
    mock
      .on("anthropic", () => ({
        status: 500,
        body: { type: "error", error: { type: "api_error", message: "boom" } },
      }))
      .on("gemini", () => ok.gemini());
    const r = await run(["smart", "commit", "--print", "--hint", "keep it short"], {
      cwd: repo.root,
      env: KEYS,
    });
    expect(r.code).toBe(0);
    const [a1, a2, g] = mock.requests;
    expect(a1?.path).toBe("/v1/messages");
    expect(a1?.headers["x-api-key"]).toBe(KEYS.ANTHROPIC_API_KEY);
    expect(a1?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(a1?.body).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(a2?.provider).toBe("anthropic");
    expect(g?.path).toBe("/v1beta/interactions");
    expect(g?.headers["x-goog-api-key"]).toBe(KEYS.GEMINI_API_KEY);
    expect(g?.body).toMatchObject({
      model: "gemini-3.5-flash-lite",
      store: false,
      generation_config: { thinking_level: "minimal" },
      response_format: { mime_type: "application/json" },
    });
    expect(JSON.stringify(g?.body)).toContain("<user_hint>keep it short</user_hint>");
  });

  it("refuses to commit without a terminal and explains every provider failure", async () => {
    stageMath();
    writeConfig();
    const before = repo.git("rev-list", "--count", "HEAD").trim();
    const noTty = await run(["smart", "commit"], { cwd: repo.root, env: KEYS });
    expect(noTty.code).toBe(2);
    expect(noTty.stderr).toMatch(/interactive terminal/);

    mock.on("openai", () => ({ status: 401, body: { error: { message: "Incorrect API key" } } }));
    const r = await run(["smart", "commit", "--print", "--no-fallback"], {
      cwd: repo.root,
      env: KEYS,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Every configured AI provider failed/);
    expect(r.stderr).toMatch(/API key rejected/);
    expect(repo.git("rev-list", "--count", "HEAD").trim()).toBe(before);
  });

  it("shows the payload without contacting any provider", async () => {
    stageMath();
    repo.write(".env", `KEY=${FAKE.openai}\n`);
    repo.git("add", ".env");
    const r = await run(["smart", "commit", "--show-payload"], { cwd: repo.root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing was sent");
    expect(r.stdout).toContain(".env (+1 −0) [content withheld: sensitive file]");
    expect(r.stdout).not.toContain(FAKE.openai);
    expect(mock.requests).toHaveLength(0);
  });

  it("doctor, models and config commands produce machine-readable output", async () => {
    const doctor = await run(["doctor", "--json"], {
      cwd: repo.root,
      env: { OPENAI_API_KEY: KEYS.OPENAI_API_KEY },
    });
    expect(doctor.code).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ area: string; message: string }>;
    };
    expect(report.checks.find((c) => c.area === "openai")?.message).toMatch(
      /key …0000 from OPENAI_API_KEY/,
    );
    expect(doctor.stdout).not.toContain(KEYS.OPENAI_API_KEY);

    const models = JSON.parse((await run(["models", "--json"], { cwd: repo.root })).stdout) as {
      providers: unknown[];
    };
    expect(models.providers).toHaveLength(4);

    expect(
      (await run(["config", "set", "providers.order", "anthropic,openai"], { cwd: repo.root }))
        .code,
    ).toBe(0);
    expect((await run(["config", "get", "providers.order"], { cwd: repo.root })).stdout).toContain(
      '"anthropic"',
    );
    expect((await run(["config", "set", "providers.order", "nope"], { cwd: repo.root })).code).toBe(
      2,
    );
    const shown = JSON.parse((await run(["config", "show"], { cwd: repo.root })).stdout) as {
      effective: { providers: { order: string[] } };
    };
    expect(shown.effective.providers.order).toEqual(["anthropic", "openai"]);
  });

  it("stores and lists keys via stdin and the opt-in file store", async () => {
    const set = await run(["auth", "set", "anthropic", "--stdin", "--insecure-file-store"], {
      cwd: repo.root,
      input: `${KEYS.ANTHROPIC_API_KEY}\n`,
    });
    expect(set.code).toBe(0);
    const list = JSON.parse(
      (await run(["auth", "list", "--json"], { cwd: repo.root })).stdout,
    ) as Array<{ provider: string; source: string | null; key: string | null }>;
    expect(list.find((r) => r.provider === "anthropic")).toMatchObject({
      source: "file",
      key: "…0000",
    });
    expect(readFileSync(join(configDir, "credentials.json"), "utf8")).toContain(
      KEYS.ANTHROPIC_API_KEY,
    );
    const noKeychain = await run(["auth", "set", "openai", "--stdin"], {
      cwd: repo.root,
      input: KEYS.OPENAI_API_KEY,
      env: { CCLI_DISABLE_KEYCHAIN: "1" },
    });
    expect(noKeychain.code).toBe(1);
    expect(noKeychain.stderr).toMatch(/keychain is not available/);
    expect((await run(["auth", "remove", "anthropic"], { cwd: repo.root })).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "prepare-commit-msg hook fills plain `git commit` and leaves -m alone",
    async () => {
      writeConfig();
      mock.on("openai", () => ok.openai());
      const bin = join(configDir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "ccli"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
      chmodSync(join(bin, "ccli"), 0o755);
      const env = {
        ...process.env,
        ...KEYS,
        CCLI_CONFIG_DIR: configDir,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_EDITOR: "true",
      };

      expect((await run(["hook", "install"], { cwd: repo.root })).code).toBe(0);
      expect(readFileSync(join(repo.root, ".git/hooks/prepare-commit-msg"), "utf8")).toContain(
        "managed-by: conventional-commits-cli",
      );

      // git must run asynchronously: the mock server lives in this process.
      const gitAsync = (args: string[]) =>
        new Promise<number>((done) =>
          spawn("git", args, { cwd: repo.root, env, stdio: "ignore" }).on("close", (c) =>
            done(c ?? 1),
          ),
        );

      stageMath();
      expect(await gitAsync(["commit", "-q"])).toBe(0);
      expect(repo.git("log", "-1", "--format=%B").trim()).toBe(
        "feat(math): ✨ add sum helper\n\nAdds a helper for adding two numbers.",
      );

      repo.write("b.txt", "b");
      repo.git("add", "b.txt");
      mock.requests.length = 0;
      expect(await gitAsync(["commit", "-q", "-m", "chore: manual message"])).toBe(0);
      expect(repo.git("log", "-1", "--format=%s").trim()).toBe("chore: manual message");
      expect(mock.requests).toHaveLength(0);

      expect((await run(["hook", "uninstall"], { cwd: repo.root })).code).toBe(0);
      expect(existsSync(join(repo.root, ".git/hooks/prepare-commit-msg"))).toBe(false);
    },
  );
});
