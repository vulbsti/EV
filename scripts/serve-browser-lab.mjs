#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../lab/browser/", import.meta.url);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer(async (request, response) => {
  try {
    const pathname = request.url === "/" ? "index.html" : normalize(request.url.slice(1));
    if (pathname.startsWith("..")) throw new Error("invalid path");
    const body = await readFile(new URL(pathname, root));
    response.writeHead(200, { "Content-Type": types[extname(pathname)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
const port = Number(process.env.EV_LAB_PORT ?? 4177);
server.listen(port, "127.0.0.1", () => console.log(`Browser audio lab: http://127.0.0.1:${port}`));
