/**
 * Signing in with an OpenCode account (the OpenCode Console), so OpenCode Zen
 * and Go are reached with the person's own account instead of a pasted key.
 * pi-ai has no sign-in for OpenCode, so this is the device flow opencode
 * itself uses (packages/core/src/plugin/provider/opencode.ts in
 * github.com/anomalyco/opencode): ask the Console for a device code, show its
 * link, poll until the person approves, then keep the access and refresh
 * tokens. Requests carry the access token, plus the workspace (org) the
 * sign-in chose.
 */
const SERVER = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";

async function post(url, body, signal) {
  const response = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => null);
  return { response, value };
}

async function get(url, token, signal) {
  const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) throw new Error(`OpenCode Console answered ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Sign-in cancelled")); }, { once: true });
});

async function credentialFrom(token, server, signal) {
  const [user, orgs] = await Promise.all([get(`${server}/api/user`, token.access_token, signal), get(`${server}/api/orgs`, token.access_token, signal)]);
  const org = token.org_id == null
    ? [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
    : orgs.find((candidate) => candidate.id === token.org_id);
  if (token.org_id != null && !org) throw new Error(`OpenCode organization not found: ${token.org_id}`);
  return { type: "oauth", access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1_000, server, email: user.email, orgId: org?.id ?? null, orgName: org?.name ?? null };
}

/** A pi-ai OAuthAuth for the OpenCode providers. */
export const opencodeConsoleOAuth = {
  name: "OpenCode account",
  isSubscription: true,
  loginLabel: "Sign in with OpenCode",
  async login(interaction) {
    const { signal } = interaction;
    const { response, value: device } = await post(`${SERVER}/auth/device/code`, { client_id: CLIENT_ID, supports_org_scope: true }, signal);
    if (!response.ok || !device?.device_code) throw new Error(`OpenCode Console did not start a sign-in (HTTP ${response.status})`);
    const url = new URL(device.verification_uri_complete, `${SERVER}/`).href;
    interaction.notify({ type: "device_code", userCode: device.user_code, verificationUri: url, intervalSeconds: device.interval, expiresInSeconds: device.expires_in });
    let wait = Math.max(1, device.interval ?? 5) * 1_000;
    for (;;) {
      await pause(wait, signal);
      const { value } = await post(`${SERVER}/auth/device/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: CLIENT_ID }, signal);
      if (value?.access_token) {
        interaction.notify({ type: "progress", message: "Signed in; reading the account." });
        return credentialFrom(value, SERVER, signal);
      }
      if (value?.error === "slow_down") wait += 5_000;
      else if (value?.error !== "authorization_pending") throw new Error(`OpenCode sign-in failed: ${value?.error ?? "no answer"}`);
    }
  },
  async refresh(credential, signal) {
    const server = credential.server ?? SERVER;
    const { response, value } = await post(`${server}/auth/device/token`, { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: CLIENT_ID }, signal);
    if (!response.ok || !value?.access_token) throw new Error(response.status === 400 ? "The OpenCode sign-in was revoked or expired; sign in again" : `OpenCode Console refused the refresh (HTTP ${response.status})`);
    return { ...credential, access: value.access_token, refresh: value.refresh_token, expires: Date.now() + value.expires_in * 1_000, ...(value.org_id ? { orgId: value.org_id } : {}) };
  },
  async toAuth(credential) {
    return { apiKey: credential.access, ...(credential.orgId ? { headers: { "x-org-id": credential.orgId } } : {}) };
  }
};
