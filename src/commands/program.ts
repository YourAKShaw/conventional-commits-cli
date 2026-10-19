import { Command, Option } from "commander";
import { VERSION } from "../meta.js";
import { setColor, setVerbose } from "../term.js";
import { createClackUI, createPlainUI, isInteractiveTerminal } from "../ui/ui.js";
import { baseContext, type CommandContext } from "./base.js";
import type { CommitOptions } from "./commit.js";
import type { SmartOptions } from "./smart.js";

// Command modules are imported on demand so `--help` and `--version` stay fast.
const auth = () => import("./auth.js");
const configCmd = () => import("./config.js");
const hookCmd = () => import("./hook.js");

interface GlobalOptions {
  cwd?: string;
  verbose?: boolean;
  color?: boolean;
}

export interface ProgramHooks {
  signal: AbortSignal;
  setExitCode: (code: number) => void;
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function buildProgram(hooks: ProgramHooks): Command {
  const program = new Command();

  const context = (command: Command): CommandContext => {
    const opts = command.optsWithGlobals<GlobalOptions>();
    if (opts.color === false) setColor(false);
    setVerbose(Boolean(opts.verbose));
    const ui = isInteractiveTerminal() ? createClackUI() : createPlainUI();
    return baseContext(ui, opts.cwd, hooks.signal);
  };
  const run =
    <A extends unknown[]>(handler: (ctx: CommandContext, ...args: A) => Promise<number>) =>
    async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const code = await handler(context(command), ...(args.slice(0, -1) as A));
      hooks.setExitCode(code);
    };

  program
    .name("ccli")
    .description(
      "Write Conventional Commits by hand (commit) or generate them from staged changes with AI (smart commit).\nAlso available as `conventional-commits-cli`.",
    )
    .version(VERSION, "-v, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .option("-C, --cwd <path>", "run as if started in <path>")
    .option("--verbose", "print diagnostics to stderr (never keys or diff content)")
    .option("--no-color", "disable colored output")
    .showHelpAfterError("(add --help for usage)")
    .exitOverride()
    .configureHelp({ sortSubcommands: false })
    .addHelpText(
      "after",
      `
Examples:
  ccli commit                       guided Conventional Commit for staged changes
  ccli smart commit                 AI-written message → review → commit
  ccli smart commit -P anthropic    start with Anthropic, fall back to the others
  ccli smart commit --show-payload  see exactly what would be sent (no network)
  ccli config init                  choose providers, models, effort and keys
  ccli doctor                       check setup

Docs: https://github.com/YourAKShaw/conventional-commits-cli#readme`,
    );

  program
    .command("commit")
    .description("create a Conventional Commit with guided prompts (manual mode)")
    .option("-t, --type <type>", "commit type, e.g. feat or fix")
    .option("-s, --scope <scope>", "scope, e.g. api (empty for none)")
    .option("-m, --message <text>", "short description for the header")
    .option("-b, --body <text>", "body text (use \\n for line breaks)")
    .option("--breaking [description]", "mark as breaking, optionally describing what breaks")
    .option("-f, --footer <footer>", 'add a footer such as "Refs: #123" (repeatable)', collect, [])
    .option("-g, --gitmoji [code]", "add a gitmoji (optionally a specific one, e.g. :bug:)")
    .option("--no-gitmoji", "do not add a gitmoji")
    .option("-a, --all", "stage modified tracked files first (like git commit -a)")
    .option("-p, --print", "print the message instead of committing (needs --type and --message)")
    .option("--retry", "reuse the message saved after a failed git commit")
    .argument("[git-args...]", "extra `git commit` options after --, e.g. -- --no-verify")
    .action(
      run(async (ctx, gitArgs: string[], opts: CommitOptions) =>
        (await import("./commit.js")).runCommit(ctx, opts, gitArgs),
      ),
    );

  const smart = program.command("smart").description("AI-assisted commands");
  smart
    .command("commit")
    .description("generate a Conventional Commit from your staged changes, review it, then commit")
    .option("-P, --provider <id>", "start with this provider: openai, anthropic, xai or gemini")
    .option("--model <id>", "model for the first provider")
    .option(
      "--effort <level>",
      "reasoning effort for the first provider (auto, minimal, low, medium, high, …)",
    )
    .option("--no-fallback", "use only the first provider")
    .option("-a, --all", "stage modified tracked files first (like git commit -a)")
    .option("-p, --print", "print the generated message instead of committing")
    .option("--show-payload", "print exactly what would be sent, then exit (no network)")
    .option("--hint <text>", "extra guidance for the message")
    .option("-g, --gitmoji", "add a gitmoji")
    .option("--no-gitmoji", "do not add a gitmoji")
    .addOption(
      new Option(
        "--hook <file>",
        "fill a prepare-commit-msg file (used by `ccli hook install`)",
      ).hideHelp(),
    )
    .argument("[git-args...]", "extra `git commit` options after --, e.g. -- --signoff")
    .action(
      run(async (ctx, gitArgs: string[], opts: SmartOptions) =>
        (await import("./smart.js")).runSmartCommit(ctx, opts, gitArgs),
      ),
    );

  const authCommand = program
    .command("auth")
    .description("manage API keys (OS keychain by default)");
  authCommand
    .command("set")
    .description("store an API key for a provider")
    .argument("<provider>", "openai, anthropic, xai or gemini")
    .option("--stdin", "read the key from standard input")
    .option("--insecure-file-store", "store in a plaintext file instead of the OS keychain")
    .action(
      run(async (ctx, provider: string, opts: { stdin?: boolean; insecureFileStore?: boolean }) =>
        (await auth()).authSet(ctx, provider, opts),
      ),
    );
  authCommand
    .command("remove")
    .description("delete a stored API key")
    .argument("<provider>")
    .action(run(async (ctx, provider: string) => (await auth()).authRemove(ctx, provider)));
  authCommand
    .command("list")
    .description("show which providers have a key and where it comes from")
    .option("--json", "machine-readable output")
    .action(run(async (ctx, opts: { json?: boolean }) => (await auth()).authList(ctx, opts)));
  authCommand
    .command("test")
    .description("make a tiny request to check keys, models and effort settings")
    .argument("[provider]")
    .action(
      run(async (ctx, provider: string | undefined) => (await auth()).authTest(ctx, provider)),
    );

  const configCommand = program.command("config").description("view and change settings");
  configCommand
    .command("init")
    .description("guided setup")
    .action(run(async (ctx) => (await configCmd()).configInit(ctx)));
  configCommand
    .command("path")
    .description("show config, credentials and cache locations")
    .action(run(async (ctx) => (await configCmd()).configPath(ctx)));
  configCommand
    .command("show")
    .description("print the effective configuration as JSON")
    .action(run(async (ctx) => (await configCmd()).configShow(ctx)));
  configCommand
    .command("get")
    .description("print one setting, e.g. providers.order")
    .argument("<key>")
    .action(run(async (ctx, key: string) => (await configCmd()).configGet(ctx, key)));
  configCommand
    .command("set")
    .description("change a global setting, e.g. providers.order anthropic,openai")
    .argument("<key>")
    .argument("<value>")
    .action(
      run(async (ctx, key: string, value: string) =>
        (await configCmd()).configSet(ctx, key, value),
      ),
    );
  configCommand
    .command("unset")
    .description("remove a global setting")
    .argument("<key>")
    .action(run(async (ctx, key: string) => (await configCmd()).configUnset(ctx, key)));

  program
    .command("doctor")
    .description("check git, config, keys, providers and hooks")
    .option("--json", "machine-readable output")
    .action(
      run(async (ctx, opts: { json?: boolean }) =>
        (await import("./doctor.js")).runDoctor(ctx, opts),
      ),
    );

  program
    .command("models")
    .description("list known models and effort levels")
    .argument("[provider]")
    .option("--json", "machine-readable output")
    .action(
      run(async (_ctx, provider: string | undefined, opts: { json?: boolean }) =>
        (await import("./models.js")).listModels(provider, opts),
      ),
    );

  const hookCommand = program
    .command("hook")
    .description("optional prepare-commit-msg hook for plain `git commit`");
  hookCommand
    .command("install")
    .description("install the hook in this repository")
    .action(run(async (ctx) => (await hookCmd()).hookInstall(ctx)));
  hookCommand
    .command("uninstall")
    .description("remove the hook")
    .action(run(async (ctx) => (await hookCmd()).hookUninstall(ctx)));
  hookCommand
    .command("status")
    .description("show whether the hook is installed")
    .action(run(async (ctx) => (await hookCmd()).hookStatus(ctx)));

  for (const command of [
    program,
    smart,
    authCommand,
    configCommand,
    hookCommand,
    ...program.commands,
    ...smart.commands,
  ]) {
    command.exitOverride();
  }
  return program;
}
