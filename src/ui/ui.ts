import process from "node:process";
import * as p from "@clack/prompts";
import { CancelledError, CliError, ExitCode } from "../errors.js";
import { c, writeErr } from "../term.js";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message?: string): void;
  error(message?: string): void;
}

/**
 * Everything user-facing goes through this interface so command flows can be tested with a
 * scripted implementation. Prompt methods throw CancelledError when the user cancels.
 */
export interface UI {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  select<T>(options: {
    message: string;
    choices: Choice<T>[];
    initialValue?: T;
    maxItems?: number;
  }): Promise<T>;
  search<T>(options: {
    message: string;
    choices: Choice<T>[];
    placeholder?: string;
    maxItems?: number;
  }): Promise<T>;
  multiselect<T>(options: {
    message: string;
    choices: Choice<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]>;
  text(options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  multiline(options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }): Promise<string>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  password(options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  spinner(): Spinner;
}

export function isInteractiveTerminal(): boolean {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.CCLI_NON_INTERACTIVE !== "1"
  );
}

function unwrap<T>(value: unknown): T {
  if (p.isCancel(value)) throw new CancelledError();
  return value as T;
}

function toOptions<T>(choices: Choice<T>[]) {
  return choices.map((ch) => ({
    value: ch.value,
    label: ch.label,
    ...(ch.hint === undefined ? {} : { hint: ch.hint }),
    ...(ch.disabled === undefined ? {} : { disabled: ch.disabled }),
  })) as never;
}

export function createClackUI(): UI {
  return {
    interactive: true,
    intro: (title) => p.intro(title),
    outro: (message) => p.outro(message),
    note: (body, title) => p.note(body, title),
    info: (message) => p.log.info(message),
    success: (message) => p.log.success(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
    step: (message) => p.log.step(message),
    async select<T>(o: {
      message: string;
      choices: Choice<T>[];
      initialValue?: T;
      maxItems?: number;
    }) {
      return unwrap<T>(
        await p.select({
          message: o.message,
          options: toOptions(o.choices),
          ...(o.initialValue === undefined ? {} : { initialValue: o.initialValue }),
          maxItems: o.maxItems ?? 12,
        }),
      );
    },
    async search<T>(o: {
      message: string;
      choices: Choice<T>[];
      placeholder?: string;
      maxItems?: number;
    }) {
      return unwrap<T>(
        await p.autocomplete({
          message: o.message,
          options: toOptions(o.choices),
          placeholder: o.placeholder ?? "Type to filter…",
          maxItems: o.maxItems ?? 10,
        } as never),
      );
    },
    async multiselect<T>(o: {
      message: string;
      choices: Choice<T>[];
      initialValues?: T[];
      required?: boolean;
    }) {
      return unwrap<T[]>(
        await p.multiselect({
          message: o.message,
          options: toOptions(o.choices),
          ...(o.initialValues === undefined ? {} : { initialValues: o.initialValues }),
          required: o.required ?? false,
        }),
      );
    },
    async text(o) {
      return unwrap<string>(
        await p.text({
          message: o.message,
          ...(o.placeholder === undefined ? {} : { placeholder: o.placeholder }),
          ...(o.initialValue === undefined ? {} : { initialValue: o.initialValue }),
          ...(o.validate ? { validate: (v: string | undefined) => o.validate?.(v ?? "") } : {}),
        }),
      );
    },
    async multiline(o) {
      return unwrap<string>(
        await p.multiline({
          message: o.message,
          ...(o.placeholder === undefined ? {} : { placeholder: o.placeholder }),
          ...(o.initialValue === undefined ? {} : { initialValue: o.initialValue }),
        }),
      );
    },
    async confirm(o) {
      return unwrap<boolean>(
        await p.confirm({ message: o.message, initialValue: o.initialValue ?? true }),
      );
    },
    async password(o) {
      return unwrap<string>(
        await p.password({
          message: o.message,
          ...(o.validate ? { validate: (v: string | undefined) => o.validate?.(v ?? "") } : {}),
        }),
      );
    },
    spinner: () => createSpinner(),
  };
}

/**
 * A spinner that only writes to stdout. Unlike clack's spinner it does not put stdin into raw
 * mode, so Ctrl-C raises SIGINT and the request is cancelled cleanly (index restored, exit 130).
 */
function createSpinner(): Spinner {
  const frames = ["◒", "◐", "◓", "◑"];
  const out = process.stdout;
  let timer: NodeJS.Timeout | undefined;
  let text = "";
  let i = 0;
  const clear = () => out.write("\r\u001b[2K");
  const render = () => {
    clear();
    out.write(`${c.magenta(frames[i++ % frames.length] ?? "")}  ${text}`);
  };
  const halt = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    clear();
    out.write("\u001b[?25h");
  };
  return {
    start(message) {
      text = message;
      out.write("\u001b[?25l");
      render();
      timer = setInterval(render, 100);
      timer.unref();
    },
    message(message) {
      text = message;
    },
    stop(message) {
      halt();
      if (message) p.log.success(message);
    },
    error(message) {
      halt();
      if (message) p.log.error(message);
    },
  };
}

/**
 * Non-interactive UI for pipes, hooks and CI: messages go to stderr (stdout stays clean for
 * --print), and any prompt fails with a clear error instead of blocking.
 */
export function createPlainUI(): UI {
  const needsTty = (what: string): never => {
    throw new CliError(`${what} needs an interactive terminal.`, {
      exitCode: ExitCode.Usage,
      hint: "Run the command in a terminal, or use --print to output the message without committing.",
    });
  };
  const line = (prefix: string, message: string) => writeErr(`${prefix} ${message}\n`);
  return {
    interactive: false,
    intro: () => {},
    outro: (message) => line(c.green("✔"), message),
    note: (body, title) => writeErr(`${title ? `${c.bold(title)}\n` : ""}${body}\n`),
    info: (message) => line(c.blue("ℹ"), message),
    success: (message) => line(c.green("✔"), message),
    warn: (message) => line(c.yellow("⚠"), message),
    error: (message) => line(c.red("✖"), message),
    step: (message) => line(c.gray("›"), message),
    select: (o) => needsTty(`"${o.message}"`),
    search: (o) => needsTty(`"${o.message}"`),
    multiselect: (o) => needsTty(`"${o.message}"`),
    text: (o) => needsTty(`"${o.message}"`),
    multiline: (o) => needsTty(`"${o.message}"`),
    confirm: (o) => needsTty(`"${o.message}"`),
    password: (o) => needsTty(`"${o.message}"`),
    spinner: () => ({
      start: (m) => line(c.gray("…"), m),
      message: () => {},
      stop: (m) => {
        if (m) line(c.green("✔"), m);
      },
      error: (m) => {
        if (m) line(c.red("✖"), m);
      },
    }),
  };
}
