import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryProviderState } from "../../src/ai/state.js";
import type { CommandContext } from "../../src/commands/base.js";
import { runCommit } from "../../src/commands/commit.js";
import { runSmartCommit } from "../../src/commands/smart.js";
import { CancelledError, CliError } from "../../src/errors.js";
import { ADAPTERS } from "../../src/providers/index.js";
import {
  type GenerateRequest,
  type ProviderAdapter,
  ProviderError,
  type ProviderId,
} from "../../src/providers/types.js";
import { createPlainUI } from "../../src/ui/ui.js";
import { FAKE } from "../helpers/fake-secrets.js";
import { CANCEL, FakeUI } from "../helpers/fake-ui.js";
import { createRepo, type TempRepo } from "../helpers/repo.js";

let repo: TempRepo;
let configDir: string;
beforeEach(() => {
  repo = createRepo();
  configDir = mkdtempSync(join(tmpdir(), "ccli-flow-cfg-"));
});
afterEach(() => repo.cleanup());

const ctx = (
  ui: FakeUI | ReturnType<typeof createPlainUI>,
  env: NodeJS.ProcessEnv = {},
): CommandContext => ({
  cwd: repo.root,
  env: { ...process.env, CCLI_CONFIG_DIR: configDir, ...env },
  ui,
  signal: new AbortController().signal,
});
const lastMessage = () => repo.git("log", "-1", "--format=%B").trim();
const commitCount = () => Number(repo.git("rev-list", "--count", "HEAD").trim());
const staged = () => repo.git("diff", "--cached", "--name-only").trim();

const draftJson = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "feat",
    scope: "math",
    gitmoji: ":sparkles:",
    description: "add sum helper",
    body: "Adds a small helper.",
    breaking: false,
    breakingDescription: "",
    footers: [],
    ...o,
  });

function fakeAdapter(
  id: ProviderId,
  outputs: Array<string | ProviderError>,
  seen: GenerateRequest[],
): ProviderAdapter {
  return {
    id,
    displayName: id,
    defaultBaseUrl: "http://unused",
    async generate(req, settings) {
      seen.push(req);
      const next = outputs.shift();
      if (next instanceof ProviderError) throw next;
      return {
        text: next ?? draftJson(),
        model: settings.model,
        latencyMs: 3,
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}
const adapters = (overrides: Partial<Record<ProviderId, ProviderAdapter>>) => ({
  ...ADAPTERS,
  ...overrides,
});

describe("manual commit (ccli commit)", () => {
  it("prompts for each field, previews, and commits only after an explicit choice", async () => {
    repo.write("math.js", "export const sum = (a, b) => a + b;\n");
    repo.git("add", "math.js");
    const ui = new FakeUI()
      .answer(/^Type of change/, "feat")
      .answer(/^Scope/, "math")
      .answer(/^Gitmoji/, ":sparkles:")
      .answer(/^Short description/, "add sum helper")
      .answer(/^Body/, "Adds a helper used by the calculator.")
      .answer(/breaking change\?/, false)
      .answer(/^Related issues/, "#12")
      .answer(/What would you like to do/, "commit");
    const code = await runCommit(ctx(ui), {}, []);
    expect(code).toBe(0);
    expect(lastMessage()).toBe(
      "feat(math): ✨ add sum helper\n\nAdds a helper used by the calculator.\n\nRefs: #12",
    );
    expect(ui.remaining()).toEqual([]);
    expect(ui.log.some((l) => l.startsWith("outro: Committed"))).toBe(true);
  });

  it("offers to stage when nothing is staged and restores the index on cancel", async () => {
    repo.write("README.md", "changed\n");
    const before = commitCount();
    const ui = new FakeUI()
      .answer(/Nothing is staged yet/, "tracked")
      .answer(/^Type of change/, "docs")
      .answer(/^Scope/, "")
      .answer(/^Gitmoji/, "")
      .answer(/^Short description/, "update readme")
      .answer(/^Body/, "")
      .answer(/breaking change\?/, false)
      .answer(/^Related issues/, "")
      .answer(/What would you like to do/, CANCEL);
    await expect(runCommit(ctx(ui), {}, [])).rejects.toBeInstanceOf(CancelledError);
    expect(commitCount()).toBe(before);
    expect(staged()).toBe("");
    expect(ui.log).toContain("info: Restored the index: the files ccli staged are unstaged again.");
  });

  it("prints a message from flags without committing", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    const before = commitCount();
    const code = await runCommit(
      ctx(createPlainUI()),
      {
        type: "fix",
        scope: "core",
        message: "handle null",
        breaking: "null is rejected",
        footer: ["Refs: #4"],
        print: true,
        gitmoji: false,
      },
      [],
    );
    expect(code).toBe(0);
    expect(commitCount()).toBe(before);
  });

  it("refuses interactive mode without a terminal", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    await expect(runCommit(ctx(createPlainUI()), {}, [])).rejects.toThrow(/needs a terminal/);
  });

  it("requires confirmation to commit with style issues and supports Edit", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    const editor = join(configDir, "editor.mjs");
    writeFileSync(
      editor,
      "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.argv[2];\nconst t = readFileSync(f, 'utf8');\nwriteFileSync(f, t.replace(/^.*$/m, 'feat: edited header'));\n",
    );
    const previous = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = `node "${editor.replace(/\\/g, "/")}"`;
    try {
      const ui = new FakeUI()
        .answer(/^Scope/, "")
        .answer(/^Gitmoji/, "")
        .answer(/^Body/, "")
        .answer(/breaking change\?/, false)
        .answer(/^Related issues/, "")
        .answer(/What would you like to do/, "commit")
        .answer(/Commit with 1 commitlint issue/, false)
        .answer(/What would you like to do/, "edit")
        .answer(/What would you like to do/, "commit");
      await runCommit(ctx(ui), { type: "feat", message: `add ${"x".repeat(80)}` }, []);
      expect(lastMessage()).toBe("feat: edited header");
    } finally {
      if (previous === undefined) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = previous;
    }
  });
});

describe("smart commit (ccli smart commit)", () => {
  const keys = {
    OPENAI_API_KEY: "sk-test-openai-0000000000",
    ANTHROPIC_API_KEY: "sk-test-anthropic-000000000",
  };

  it("asks once before sending, generates, reviews and commits", async () => {
    repo.write("math.js", "export const sum = (a, b) => a + b;\n");
    repo.git("add", "math.js");
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI()
      .answer(/Allow sending diffs/, true)
      .answer(/What would you like to do/, "commit");
    const code = await runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
      adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen) }),
      state: memoryProviderState(),
    });
    expect(code).toBe(0);
    expect(lastMessage()).toBe("feat(math): ✨ add sum helper\n\nAdds a small helper.");
    expect(seen[0]?.user).toContain("+export const sum = (a, b) => a + b;");
    const saved = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(saved.smart.acknowledgedProviders).toEqual(["openai"]);
  });

  it("falls back to the next provider when the primary is out of credits", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai", "anthropic"] } }),
    );
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI().answer(/What would you like to do/, "commit");
    await runSmartCommit(ctx(ui, keys), {}, [], {
      adapters: adapters({
        openai: fakeAdapter(
          "openai",
          [
            new ProviderError(
              "openai",
              "quota",
              "Credits exhausted (429 credit_balance_exhausted)",
            ),
          ],
          seen,
        ),
        anthropic: fakeAdapter(
          "anthropic",
          [draftJson({ type: "fix", scope: "", gitmoji: "", description: "correct value" })],
          seen,
        ),
      }),
      state: memoryProviderState(),
    });
    expect(lastMessage()).toBe("fix: 🐛 correct value\n\nAdds a small helper.");
    expect(ui.log.some((l) => l.includes("warn: OpenAI: Credits exhausted"))).toBe(true);
    expect(ui.log.some((l) => l.includes("Anthropic"))).toBe(true);
  });

  it("withholds content with possible secrets before anything is sent", async () => {
    repo.write("config.js", `export const token = "${FAKE.github}";\n`);
    repo.write("app.js", "console.log('hi');\n");
    repo.write(".env", `API_KEY=${FAKE.openai}\n`);
    repo.git("add", "-A");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI()
      .answer(/How should these be handled/, "exclude")
      .answer(/What would you like to do/, "cancel");
    await expect(
      runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
        adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen) }),
        state: memoryProviderState(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    const sent = `${seen[0]?.system}\n${seen[0]?.user}`;
    expect(sent).not.toContain(FAKE.github);
    expect(sent).not.toContain(FAKE.openai);
    expect(sent).toContain("config.js (+1 −0) [content withheld: possible secret]");
    expect(sent).toContain(".env (+1 −0) [content withheld: sensitive file]");
    expect(sent).toContain("console.log('hi');");
    expect(ui.log.some((l) => l.includes("You are committing") && l.includes(".env"))).toBe(true);
  });

  it("redacts matches when the user chooses to", async () => {
    repo.write("config.js", `export const token = "${FAKE.github}";\nexport const ok = 1;\n`);
    repo.git("add", "-A");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI()
      .answer(/How should these be handled/, "redact")
      .answer(/What would you like to do/, "cancel");
    await expect(
      runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
        adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen) }),
        state: memoryProviderState(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(seen[0]?.user).not.toContain(FAKE.github);
    expect(seen[0]?.user).toContain("[REDACTED:");
    expect(seen[0]?.user).toContain("export const ok = 1;");
  });

  it("sends flagged content only after the user types 'send'", async () => {
    repo.write("config.js", `export const token = "${FAKE.github}";\n`);
    repo.git("add", "-A");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI()
      .answer(/How should these be handled/, "send")
      .answer(/Type "send" to confirm/, "send")
      .answer(/What would you like to do/, "cancel");
    await expect(
      runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
        adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen) }),
        state: memoryProviderState(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ui.prompts.some((p) => p.startsWith('text: Type "send"'))).toBe(true);
    expect(seen[0]?.user).toContain(FAKE.github);

    // Anything other than the exact word is refused by the prompt's validation.
    const refusing = new FakeUI()
      .answer(/How should these be handled/, "send")
      .answer(/Type "send" to confirm/, "yes");
    const seen2: GenerateRequest[] = [];
    await expect(
      runSmartCommit(ctx(refusing, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
        adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen2) }),
        state: memoryProviderState(),
      }),
    ).rejects.toThrow(/failed validation/);
    expect(seen2).toHaveLength(0);
  });

  it("withholds flagged content without asking when there is no terminal", async () => {
    repo.write("config.js", `export const token = "${FAKE.github}";\nexport const ok = 1;\n`);
    repo.git("add", "-A");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const seen: GenerateRequest[] = [];
    const code = await runSmartCommit(
      ctx(createPlainUI(), { OPENAI_API_KEY: keys.OPENAI_API_KEY }),
      { print: true },
      [],
      {
        adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], seen) }),
        state: memoryProviderState(),
      },
    );
    expect(code).toBe(0);
    expect(seen[0]?.user).not.toContain(FAKE.github);
    expect(seen[0]?.user).not.toContain("export const ok = 1;");
    expect(seen[0]?.user).toContain("config.js (+2 −0) [content withheld: possible secret]");
    expect(commitCount()).toBe(1);
  });

  it("explains the fix when the repository allow-list excludes every configured provider", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    repo.write(".ccli.json", JSON.stringify({ providers: { allow: ["gemini"] } }));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ providers: { order: ["openai", "anthropic"] } }),
    );
    const promise = runSmartCommit(ctx(new FakeUI(), keys), {}, [], {
      state: memoryProviderState(),
    });
    await expect(promise).rejects.toThrow(/only allows gemini/);
    await expect(promise).rejects.toMatchObject({
      hint: expect.stringContaining("ccli config set providers.order gemini"),
    });
  });

  it("regenerates with a hint and avoids the previous suggestion", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const seen: GenerateRequest[] = [];
    const ui = new FakeUI()
      .answer(/What would you like to do/, "regenerate")
      .answer(/focus on/, "mention the parser")
      .answer(/What would you like to do/, "commit");
    await runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
      adapters: adapters({
        openai: fakeAdapter(
          "openai",
          [draftJson(), draftJson({ scope: "parser", description: "handle input" })],
          seen,
        ),
      }),
      state: memoryProviderState(),
    });
    expect(seen[1]?.user).toContain("<user_hint>mention the parser</user_hint>");
    expect(seen[1]?.user).toContain(
      "<previous_suggestion>feat(math): ✨ add sum helper</previous_suggestion>",
    );
    expect(lastMessage()).toBe("feat(parser): ✨ handle input\n\nAdds a small helper.");
  });

  it("never commits without a terminal unless asked to print, and prints without committing", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ smart: { acknowledgedProviders: ["openai"] } }),
    );
    const before = commitCount();
    const deps = {
      adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], []) }),
      state: memoryProviderState(),
    };
    await expect(
      runSmartCommit(ctx(createPlainUI(), { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], deps),
    ).rejects.toThrow(/interactive terminal/);
    expect(
      await runSmartCommit(
        ctx(createPlainUI(), { OPENAI_API_KEY: keys.OPENAI_API_KEY }),
        { print: true },
        [],
        deps,
      ),
    ).toBe(0);
    expect(commitCount()).toBe(before);
  });

  it("skips unapproved providers without a terminal", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    await expect(
      runSmartCommit(
        ctx(createPlainUI(), { OPENAI_API_KEY: keys.OPENAI_API_KEY }),
        { print: true },
        [],
        {
          adapters: adapters({ openai: fakeAdapter("openai", [draftJson()], []) }),
          state: memoryProviderState(),
        },
      ),
    ).rejects.toThrow(/No provider has been approved/);
  });

  it("explains how to add a key when none is configured", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    const promise = runSmartCommit(ctx(new FakeUI()), {}, [], { state: memoryProviderState() });
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/No AI provider is ready/);
  });

  it("respects a repository provider allow-list and refuses smart mode when the repository disables it", async () => {
    repo.write("a.txt", "1");
    repo.git("add", "a.txt");
    repo.write(".ccli.json", JSON.stringify({ providers: { allow: ["anthropic"] } }));
    await expect(
      runSmartCommit(ctx(new FakeUI(), keys), { provider: "openai" }, [], {
        state: memoryProviderState(),
      }),
    ).rejects.toThrow(/does not allow openai/);
    repo.write(".ccli.json", JSON.stringify({ smart: { enabled: false } }));
    await expect(
      runSmartCommit(ctx(new FakeUI(), keys), {}, [], { state: memoryProviderState() }),
    ).rejects.toThrow(/disabled for this repository/);
  });

  it("restores staging done by ccli when the user cancels during approval", async () => {
    repo.write("README.md", "changed\n");
    const ui = new FakeUI()
      .answer(/Nothing is staged yet/, "tracked")
      .answer(/Allow sending diffs/, false);
    await expect(
      runSmartCommit(ctx(ui, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), {}, [], {
        state: memoryProviderState(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(staged()).toBe("");
  });

  it("shows the exact payload without network access or keys", async () => {
    repo.write("a.js", "const a = 1;\n");
    repo.git("add", "a.js");
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string, cb?: () => void) => {
      writes.push(String(chunk));
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await runSmartCommit(ctx(createPlainUI()), { showPayload: true }, [])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(writes.join("")).toContain("# Payload preview — nothing was sent");
    expect(writes.join("")).toContain("+const a = 1;");
  });
});
