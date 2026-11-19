import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Subscription sign-ins (ChatGPT, GitHub Copilot, SuperGrok, OpenRouter...),
 * each as a short-lived attempt the settings screen polls, the way opencode
 * does it. pi-ai runs the provider's own flow; this only relays it:
 *
 *   started -> waiting (a link, or a device code) -> completing -> saved
 *                     \-> waiting with a question (paste the code or the
 *                         redirect URL, when the browser cannot reach EV)
 *   any of them -> failed | expired (10 minutes) | cancelled
 *
 * An attempt lives in memory only. Its result, a connection, is what is kept.
 */
const LIFETIME_MS = 10 * 60_000;
const ENDED = new Set(["saved", "failed", "expired", "cancelled"]);
const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });

/**
 * Who signed in. Some flows (ChatGPT) are handed an OpenID ID token that
 * names the account, then drop it; their access token says nothing about who
 * it is. So while a sign-in runs, a token answer it receives is read for the
 * ID token's email, for the account's hint only. Calls outside a sign-in pass
 * through untouched.
 */
const signingIn = new AsyncLocalStorage();
let watching = false;
function watchTokenAnswers() {
  if (watching) return;
  watching = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const answer = await original(...args);
    const attempt = signingIn.getStore();
    if (attempt && answer.ok && /json/.test(answer.headers.get("content-type") ?? "")) {
      try {
        const value = await answer.clone().json();
        const claims = JSON.parse(Buffer.from(String(value?.id_token).split(".")[1], "base64url").toString());
        if (typeof claims.email === "string") attempt.email = claims.email;
      } catch {}
    }
    return answer;
  };
}

export class SignIns {
  constructor({ connections, lifetimeMs = LIFETIME_MS }) {
    this.connections = connections;
    this.lifetimeMs = lifetimeMs;
    this.attempts = new Map();
  }

  start({ provider, label = null }) {
    const offered = this.connections.providers().find((entry) => entry.id === provider);
    if (!offered?.signIn) throw coded("SIGN_IN_NOT_OFFERED", `EV offers no subscription sign-in for ${provider}`, 400);
    const oauth = this.connections.models.getProvider(provider).auth.oauth;
    const controller = new AbortController();
    const attempt = {
      id: randomUUID(), provider, label, state: "started", url: null, deviceCode: null, instructions: null,
      question: null, answer: null, messages: [], error: null, connectionId: null,
      expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(), controller
    };
    this.attempts.set(attempt.id, attempt);
    const end = (state, error = null) => {
      if (ENDED.has(attempt.state)) return false;
      attempt.state = state;
      attempt.error = error;
      attempt.question = null;
      clearTimeout(timer);
      // Kept a while so the screen can read how it ended.
      setTimeout(() => this.attempts.delete(attempt.id), this.lifetimeMs).unref?.();
      return true;
    };
    attempt.end = end;
    const timer = setTimeout(() => { if (end("expired")) controller.abort(); }, this.lifetimeMs);
    timer.unref?.();
    const interaction = {
      signal: controller.signal,
      // A question the flow asks: paste the code or the redirect URL, or a
      // detail such as an enterprise domain. A choice takes the first option.
      prompt: (prompt) => new Promise((resolve, reject) => {
        if (prompt.type === "select") return resolve(prompt.options[0]?.id ?? "");
        const asked = { message: prompt.message, placeholder: prompt.placeholder ?? null, secret: prompt.type === "secret" };
        attempt.question = asked;
        attempt.answer = (text) => { attempt.question = null; attempt.answer = null; resolve(text); };
        if (attempt.state === "started") attempt.state = "waiting";
        prompt.signal?.addEventListener("abort", () => { if (attempt.question === asked) { attempt.question = null; attempt.answer = null; } reject(new Error("The question was withdrawn")); }, { once: true });
      }),
      notify: (event) => {
        if (event.type === "auth_url") Object.assign(attempt, { url: event.url, instructions: event.instructions ?? null });
        else if (event.type === "device_code") Object.assign(attempt, { url: event.verificationUri, deviceCode: event.userCode });
        else if (event.message) attempt.messages.push(event.message);
        if (event.type === "progress" && attempt.url) attempt.state = "completing";
        else if (attempt.state === "started") attempt.state = "waiting";
      }
    };
    watchTokenAnswers();
    signingIn.run(attempt, () => oauth.login(interaction, { getDeviceId: () => this.connections.deviceId(), agentName: "EV" }))
      .then((credential) => {
        if (ENDED.has(attempt.state)) return;
        const email = credential.email ?? attempt.email;
        attempt.connectionId = this.connections.save({ provider, method: "oauth", credential: email ? { ...credential, email } : credential, label }).id;
        end("saved");
      })
      .catch((error) => end("failed", String(error?.message ?? error).slice(0, 500)));
    return this.view(attempt);
  }

  _find(id) {
    const attempt = this.attempts.get(id);
    if (!attempt) throw coded("SIGN_IN_NOT_FOUND", "This sign-in has ended or never started", 404);
    return attempt;
  }

  get(id) { return this.view(this._find(id)); }

  /** The person's answer to the question the flow asked (usually the pasted code or redirect URL). */
  answer(id, text) {
    const attempt = this._find(id);
    if (!attempt.answer) throw coded("SIGN_IN_NOT_ASKING", "This sign-in is not waiting for anything to be pasted", 409);
    attempt.state = "completing";
    attempt.answer(String(text ?? "").trim());
    return this.view(attempt);
  }

  cancel(id) {
    const attempt = this._find(id);
    if (attempt.end("cancelled")) attempt.controller.abort();
    return this.view(attempt);
  }

  view(attempt) {
    const { controller, answer, question, end, email, ...shown } = attempt;
    return { ...shown, paste: Boolean(question), question: question?.message ?? null, placeholder: question?.placeholder ?? null };
  }
}
