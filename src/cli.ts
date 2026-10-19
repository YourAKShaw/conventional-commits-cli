import process from "node:process";
import { CommanderError } from "commander";
import { buildProgram } from "./commands/program.js";
import { CancelledError, CliError, ExitCode } from "./errors.js";
import { ISSUES_URL } from "./meta.js";
import { c, isVerbose, writeErr } from "./term.js";

async function main(argv: string[]): Promise<number> {
  const controller = new AbortController();
  // First Ctrl-C cancels in-flight work cleanly; a second one exits immediately.
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(ExitCode.Cancelled);
    controller.abort();
  });

  let exitCode: number = ExitCode.Ok;
  const program = buildProgram({
    signal: controller.signal,
    setExitCode: (code) => (exitCode = code),
  });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    exitCode = reportError(error);
  }
  return exitCode;
}

function reportError(error: unknown): number {
  if (error instanceof CommanderError) {
    // Commander already printed help, the version or the usage problem.
    if (
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version" ||
      error.code === "commander.help"
    ) {
      return ExitCode.Ok;
    }
    return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
  }
  if (error instanceof CancelledError) {
    writeErr(`${c.yellow("■")} ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof CliError) {
    writeErr(`${c.red("✖")} ${error.message}\n`);
    if (error.hint) writeErr(`  ${c.dim(error.hint)}\n`);
    if (isVerbose() && error.cause)
      writeErr(`${c.dim(String((error.cause as Error).stack ?? error.cause))}\n`);
    return error.exitCode;
  }
  const err = error as Error;
  writeErr(`${c.red("✖")} Unexpected error: ${err?.message ?? String(error)}\n`);
  writeErr(`  ${c.dim(`Please report it at ${ISSUES_URL} with the output of \`ccli doctor\`.`)}\n`);
  if (isVerbose() && err?.stack) writeErr(`${c.dim(err.stack)}\n`);
  return ExitCode.Error;
}

main(process.argv).then(
  (code) => process.exit(code),
  (error) => process.exit(reportError(error)),
);
