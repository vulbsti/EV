import { readFile } from "node:fs/promises";

const BASE_URL = "https://openrouter.ai/api/v1";

async function checkedFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function headers(apiKey, accept) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(accept ? { Accept: accept } : {}),
    "HTTP-Referer": "http://localhost/ev-lab",
    "X-Title": "EV Experiment Lab"
  };
}

export async function discoverModels({ outputModalities, timeoutMs = 30_000 }) {
  const url = new URL(`${BASE_URL}/models`);
  if (outputModalities) url.searchParams.set("output_modalities", outputModalities);
  const started = performance.now();
  const response = await checkedFetch(url, {}, timeoutMs);
  const body = await response.json();
  return { models: body.data ?? [], latencyMs: performance.now() - started };
}

export async function transcribe({ apiKey, model, audioPath, format, timeoutMs = 60_000 }) {
  const audio = await readFile(audioPath);
  return transcribeBuffer({ apiKey, model, audio, format, timeoutMs });
}

export async function transcribeBuffer({ apiKey, model, audio, format, timeoutMs = 60_000 }) {
  const started = performance.now();
  const response = await checkedFetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ model, input_audio: { data: audio.toString("base64"), format } })
  }, timeoutMs);
  const body = await response.json();
  return { body, latencyMs: performance.now() - started, inputBytes: audio.length };
}

export async function synthesize({ apiKey, model, voice, text, format = "mp3", timeoutMs = 60_000 }) {
  const started = performance.now();
  const response = await checkedFetch(`${BASE_URL}/audio/speech`, {
    method: "POST",
    headers: headers(apiKey, "audio/*"),
    body: JSON.stringify({ model, voice, input: text, response_format: format })
  }, timeoutMs);
  const firstByteMs = performance.now() - started;
  const audio = Buffer.from(await response.arrayBuffer());
  return {
    audio,
    firstByteMs,
    totalLatencyMs: performance.now() - started,
    contentType: response.headers.get("content-type"),
    generationId: response.headers.get("x-generation-id")
  };
}
