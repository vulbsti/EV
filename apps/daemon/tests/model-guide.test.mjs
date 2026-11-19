import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ATLAS_DIR, loadAtlas } from "../lib/model-guide.mjs";

test("every line of the shipped model atlas is read: each claim says how it is known and where from", () => {
  const files = readdirSync(ATLAS_DIR).filter((file) => file.endsWith(".md") && file !== "README.md");
  const atlas = loadAtlas();
  assert.equal(atlas.length, files.length, "an atlas file has no header");
  for (const file of files) {
    const written = readFileSync(join(ATLAS_DIR, file), "utf8").split("---").slice(2).join("---").split("\n").filter((line) => line.trim().startsWith("-")).length;
    const entry = atlas.find((candidate) => candidate.file === file);
    assert.equal(entry.claims.length, written, `${file}: a claim does not end with [state: source, date]`);
    for (const claim of entry.claims) assert.ok(claim.source, `${file}: "${claim.text}" says how it is known but not where from`);
  }
});
