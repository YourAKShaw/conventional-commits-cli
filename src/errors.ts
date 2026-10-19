export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
  Cancelled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error whose message is safe and useful to show to the user as-is. */
export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: ExitCodeValue; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? ExitCode.Error;
    this.hint = options.hint;
  }
}

export class CancelledError extends CliError {
  constructor(message = "Cancelled. Nothing was committed.") {
    super(message, { exitCode: ExitCode.Cancelled });
    this.name = "CancelledError";
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
