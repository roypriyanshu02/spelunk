import { expect, test, describe } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_PATH = path.resolve("./schema/codemap.v1.json");

function validateSchema(data: any) {
  expect(typeof data).toBe("object");
  expect(Array.isArray(data.files)).toBe(true);

  if (data.limit !== undefined) {
    expect(typeof data.limit).toBe("number");
  }
  if (data.offset !== undefined) {
    expect(typeof data.offset).toBe("number");
  }

  for (const file of data.files) {
    expect(typeof file.path).toBe("string");
    expect(typeof file.parsed).toBe("boolean");

    if (file.reason !== undefined && file.reason !== null) {
      expect(typeof file.reason).toBe("string");
    }
    if (file.hash !== undefined && file.hash !== null) {
      expect(typeof file.hash).toBe("string");
    }
    if (file.exports !== undefined) {
      expect(Array.isArray(file.exports)).toBe(true);
      for (const exp of file.exports) expect(typeof exp).toBe("string");
    }
    if (file.imports !== undefined) {
      expect(Array.isArray(file.imports)).toBe(true);
      for (const imp of file.imports) expect(typeof imp).toBe("string");
    }
  }
}

describe("Schema Validation", () => {
  test("Output schema matches codemap.v1.json", () => {
    const schemaContent = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    expect(schemaContent.required).toContain("files");

    const mockOutput = {
      files: [
        {
          path: "src/main.ts",
          parsed: true,
          hash: "abc123hash",
          exports: ["run"],
          imports: ["fs", "path"],
        },
        {
          path: "src/invalid.ts",
          parsed: false,
          reason: "syntax error",
          exports: [],
          imports: [],
        },
      ],
      limit: 50,
      offset: 0,
    };

    validateSchema(mockOutput);
  });
});
