const TOKEN_URL = "https://api.x.ai/v1/realtime/client_secrets";
const SOCKET_URL = "wss://api.x.ai/v1/realtime";

async function ephemeralToken(apiKey, timeoutMs) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`xAI token HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = await response.json();
  return body.value ?? body.client_secret?.value ?? body.client_secret ?? body.token;
}

export async function probeXaiRealtime({ apiKey, model, voice, prompt, timeoutMs = 30_000 }) {
  const tokenStarted = performance.now();
  const token = await ephemeralToken(apiKey, timeoutMs);
  const tokenLatencyMs = performance.now() - tokenStarted;
  if (!token) throw new Error("xAI ephemeral-token response did not include a token");

  return await new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = new WebSocket(`${SOCKET_URL}?model=${encodeURIComponent(model)}`, [`xai-client-secret.${token}`]);
    const events = [];
    let firstAudioMs = null;
    let audioBytes = 0;
    let transcript = "";
    const timeout = setTimeout(() => finish(new Error("xAI realtime probe timed out")), timeoutMs);

    function finish(error) {
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve({ tokenLatencyMs, connectAndResponseMs: performance.now() - started, firstAudioMs, audioBytes, transcript, eventTypes: [...new Set(events)] });
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "session.update",
        session: { voice, instructions: "You are a transport probe. Keep the reply under twelve words.", output_audio_format: "pcm16" }
      }));
      socket.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }
      }));
      socket.send(JSON.stringify({ type: "response.create" }));
    });
    socket.addEventListener("message", (message) => {
      if (typeof message.data !== "string") {
        if (firstAudioMs === null) firstAudioMs = performance.now() - started;
        audioBytes += message.data?.byteLength ?? message.data?.size ?? 0;
        return;
      }
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      events.push(event.type);
      if (event.type === "error") return finish(new Error(event.error?.message ?? "xAI realtime error"));
      if (/audio\.delta$/.test(event.type) && event.delta) {
        if (firstAudioMs === null) firstAudioMs = performance.now() - started;
        audioBytes += Buffer.byteLength(event.delta, "base64");
      }
      if (/transcript\.delta$/.test(event.type)) transcript += event.delta ?? "";
      if (event.type === "response.done") finish();
    });
    socket.addEventListener("error", () => finish(new Error("xAI realtime WebSocket failed")));
  });
}
