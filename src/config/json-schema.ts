import { z } from "zod";
import { globalConfigSchema, repoConfigSchema } from "./schema.js";

const BASE = "https://raw.githubusercontent.com/YourAKShaw/conventional-commits-cli/main/schema";

/** JSON Schemas for editor completion, generated from the zod schemas (see `npm run schema`). */
export function configJsonSchemas(): Record<string, object> {
  return {
    "config.schema.json": {
      ...z.toJSONSchema(globalConfigSchema, { io: "input" }),
      $id: `${BASE}/config.schema.json`,
      title: "conventional-commits-cli global configuration",
    },
    "repo-config.schema.json": {
      ...z.toJSONSchema(repoConfigSchema, { io: "input" }),
      $id: `${BASE}/repo-config.schema.json`,
      title: "conventional-commits-cli repository configuration (.ccli.json)",
    },
  };
}
