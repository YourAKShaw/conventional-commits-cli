import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configJsonSchemas } from "../../src/config/json-schema.js";

describe("published JSON schemas", () => {
  it.each(Object.entries(configJsonSchemas()))(
    "schema/%s is up to date (run `npm run schema`)",
    (name, schema) => {
      expect(JSON.parse(readFileSync(`schema/${name}`, "utf8"))).toEqual(
        JSON.parse(JSON.stringify(schema)),
      );
    },
  );
});
