import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  files?: string[];
  pi?: { extensions?: string[] };
};

test("package manifest ships and registers the cache guard extension", () => {
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/cache-guard/index.ts"]);
  assert.ok(manifest.files?.includes("extensions/cache-guard/index.ts"));
  assert.ok(manifest.files?.includes("extensions/cache-guard/README.md"));
});
