import process from "node:process";
import type { UI } from "../ui/ui.js";

/** Minimal context every command receives. Kept free of heavy imports for fast startup. */
export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ui: UI;
  signal: AbortSignal;
}

export function baseContext(ui: UI, cwd: string | undefined, signal: AbortSignal): CommandContext {
  return { cwd: cwd ?? process.cwd(), env: process.env, ui, signal };
}
