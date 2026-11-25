import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(TESTS_DIR, "fixtures");
const TRANSFORM = path.resolve(
  TESTS_DIR,
  "..",
  "workflow",
  "text-transformer.alfredui",
  "transform",
);

interface TransformResponse {
  update: {
    ids: {
      textOutput: {
        text: string;
      };
    };
  };
}

function runTransform(name: string, input: string): string {
  const stdout = execFileSync(TRANSFORM, [name, input], { encoding: "utf8" });
  const payload = JSON.parse(stdout) as TransformResponse;
  return payload.update.ids.textOutput.text;
}

function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

describe("stripClean fixtures", () => {
  const inputs = readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".in.txt"))
    .sort();

  for (const inputFile of inputs) {
    const caseName = inputFile.replace(/\.in\.txt$/, "");
    const outputFile = `${caseName}.out.txt`;

    it(caseName, () => {
      const before = stripTrailingNewline(
        readFileSync(path.join(FIXTURES_DIR, inputFile), "utf8"),
      );
      const expected = stripTrailingNewline(
        readFileSync(path.join(FIXTURES_DIR, outputFile), "utf8"),
      );
      assert.equal(runTransform("stripClean", before), expected);
    });
  }
});

describe("stripClean edge cases", () => {
  it("peels nested quotes one layer per run", () => {
    const once = runTransform("stripClean", "> > deep quote\n> > second line");
    assert.equal(once, "> deep quote\n> second line");
    assert.equal(runTransform("stripClean", once), "deep quote\nsecond line");
  });

  it("is idempotent on already-cleaned output", () => {
    const cleaned = runTransform("stripClean", '?? "a"\n?? "b"');
    assert.equal(runTransform("stripClean", cleaned), cleaned);
  });

  it("handles empty input", () => {
    assert.equal(runTransform("stripClean", ""), "");
  });
});
