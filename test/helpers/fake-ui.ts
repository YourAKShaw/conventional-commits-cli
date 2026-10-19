import { CancelledError } from "../../src/errors.js";
import type { Choice, Spinner, UI } from "../../src/ui/ui.js";

type Answer = unknown | ((choices: Choice<unknown>[] | undefined, message: string) => unknown);

/**
 * Scripted UI: each prompt consumes the next answer whose matcher fits the prompt message.
 * Use CANCEL to simulate the user pressing Ctrl+C. Output is recorded for assertions.
 */
export const CANCEL = Symbol("cancel");

export class FakeUI implements UI {
  readonly interactive = true;
  readonly log: string[] = [];
  readonly prompts: string[] = [];
  private readonly queue: Array<{ match: RegExp; answer: Answer }> = [];

  answer(match: RegExp, answer: Answer): this {
    this.queue.push({ match, answer });
    return this;
  }

  private next(kind: string, message: string, choices?: Choice<unknown>[]): unknown {
    this.prompts.push(`${kind}: ${message}`);
    const index = this.queue.findIndex((q) => q.match.test(message));
    if (index === -1) throw new Error(`FakeUI: no scripted answer for ${kind} "${message}"`);
    const { answer } = this.queue.splice(index, 1)[0] as { answer: Answer };
    const value =
      typeof answer === "function"
        ? (answer as (c: unknown, m: string) => unknown)(choices, message)
        : answer;
    if (value === CANCEL) throw new CancelledError();
    if (choices && kind !== "multiselect") {
      const choice = choices.find((c) => c.value === value);
      if (!choice) throw new Error(`FakeUI: ${String(value)} is not a choice for "${message}"`);
      if (choice.disabled) throw new Error(`FakeUI: ${String(value)} is disabled for "${message}"`);
    }
    return value;
  }

  remaining(): string[] {
    return this.queue.map((q) => String(q.match));
  }

  intro(t: string) {
    this.log.push(`intro: ${t}`);
  }
  outro(t: string) {
    this.log.push(`outro: ${t}`);
  }
  note(b: string, t?: string) {
    this.log.push(`note${t ? ` (${t})` : ""}: ${b}`);
  }
  info(m: string) {
    this.log.push(`info: ${m}`);
  }
  success(m: string) {
    this.log.push(`success: ${m}`);
  }
  warn(m: string) {
    this.log.push(`warn: ${m}`);
  }
  error(m: string) {
    this.log.push(`error: ${m}`);
  }
  step(m: string) {
    this.log.push(`step: ${m}`);
  }
  async select<T>(o: { message: string; choices: Choice<T>[] }): Promise<T> {
    return this.next("select", o.message, o.choices as Choice<unknown>[]) as T;
  }
  async search<T>(o: { message: string; choices: Choice<T>[] }): Promise<T> {
    return this.next("search", o.message, o.choices as Choice<unknown>[]) as T;
  }
  async multiselect<T>(o: { message: string; choices: Choice<T>[] }): Promise<T[]> {
    return this.next("multiselect", o.message, o.choices as Choice<unknown>[]) as T[];
  }
  async text(o: {
    message: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string> {
    const value = String(this.next("text", o.message));
    const error = o.validate?.(value);
    if (error) throw new Error(`FakeUI: "${value}" failed validation for "${o.message}": ${error}`);
    return value;
  }
  async multiline(o: { message: string }): Promise<string> {
    return String(this.next("multiline", o.message));
  }
  async confirm(o: { message: string }): Promise<boolean> {
    return Boolean(this.next("confirm", o.message));
  }
  async password(o: { message: string }): Promise<string> {
    return String(this.next("password", o.message));
  }
  spinner(): Spinner {
    return {
      start: (m) => this.log.push(`spinner: ${m}`),
      message: () => {},
      stop: (m) => this.log.push(`spinner stop: ${m ?? ""}`),
      error: (m) => this.log.push(`spinner error: ${m ?? ""}`),
    };
  }
}
