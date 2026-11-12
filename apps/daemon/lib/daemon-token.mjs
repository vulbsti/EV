import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateFileSync } from "./file-permissions.mjs";

/**
 * A per-start secret that every API call must carry, so another local
 * process (or an agent with curl) cannot read the person's data or write
 * memory as them. The browser gets it once, from the link the daemon prints,
 * and keeps it in a strict same-site cookie; local tools send it as a bearer
 * token, read from <data>/api-token. EV_API_TOKEN pins it (tests, QA).
 */
export const COOKIE = "ev_session";

export function createDaemonToken({ dataRoot, env = process.env }) {
  const token = env.EV_API_TOKEN || randomBytes(32).toString("base64url");
  const path = join(dataRoot, "api-token");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  ensurePrivateFileSync(path);
  return { token, path };
}

function same(expected, given) {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** True when the request carries the token as a bearer header or as the session cookie. */
export function carriesToken(request, token) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization ?? ""))?.[1];
  return same(token, bearer) || same(token, cookieValue(request.headers.cookie, COOKIE));
}

/** Set-Cookie header value for a browser that opened the printed link. */
export function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export { same as tokenMatches };
