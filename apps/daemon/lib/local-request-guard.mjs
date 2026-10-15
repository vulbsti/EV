import { isIP } from "node:net";

// The daemon has no auth, so only the person's own browser tab or local tools may reach it.
// A Host allowlist blocks DNS rebinding; an Origin check blocks cross-site requests from any open web page.

function isLoopbackName(hostname) {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name === "::1") return true;
  return isIP(name) === 4 && name.startsWith("127.");
}

function splitHost(value) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
  return match ? { hostname: match[1], port: match[2] ? Number(match[2]) : null } : null;
}

export function localRequestRejection({ host, origin, port }) {
  const parsed = splitHost(String(host ?? "").trim());
  if (!parsed || !isLoopbackName(parsed.hostname) || parsed.port !== port) return "Host is not this local EV daemon";
  if (origin === undefined) return null;
  let url;
  try { url = new URL(origin); } catch { return "Origin is not this local EV daemon"; }
  if (url.protocol !== "http:" || !isLoopbackName(url.hostname) || Number(url.port || 80) !== port) return "Origin is not this local EV daemon";
  return null;
}
