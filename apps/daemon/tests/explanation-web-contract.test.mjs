import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("explanation window exposes every scripted control and capability-lab route", async () => {
  const [html, javascript, css] = await Promise.all([
    readFile(resolve(projectRoot, "apps/web/explain.html"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/explain.js"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/explain.css"), "utf8")
  ]);
  const idsMatch = javascript.match(/const ids = (\[[^;]+\]);/);
  assert.ok(idsMatch, "scripted element registry must be statically inspectable");
  const scriptedIds = JSON.parse(idsMatch[1]);
  const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "HTML IDs must be unique");
  for (const id of scriptedIds) assert.ok(htmlIds.includes(id), `missing scripted element #${id}`);

  for (const route of [
    "/api/explain/task-context",
    "/api/capabilities",
    "/api/experiments/run",
    "/api/experiments/acceptance-suite"
  ]) assert.match(javascript, new RegExp(route.replaceAll("/", "\\/")));

  assert.match(html, /data-stage="explanation"/);
  assert.match(html, /data-stage="lab"/);
  assert.match(html, /id="lab-run-tabs"/);
  assert.match(css, /\.lab-run-tabs button\.active/);
});
