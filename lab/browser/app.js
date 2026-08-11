const elements = Object.fromEntries(["start", "stop", "play", "download", "export", "output", "reference", "level"].map((id) => [id, document.getElementById(id)]));
let stream;
let recorder;
let audioContext;
let chunks = [];
let chunkTimes = [];
let blob;
let probe;

function download(value, name, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(value instanceof Blob ? value : new Blob([value], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

elements.start.onclick = async () => {
  const permissionStarted = performance.now();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    elements.output.textContent = `Microphone failed: ${error.name}: ${error.message}`;
    return;
  }
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  source.connect(analyser);
  const values = new Uint8Array(analyser.fftSize);
  const showLevel = () => {
    if (!recorder || recorder.state !== "recording") return;
    analyser.getByteTimeDomainData(values);
    const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length);
    elements.level.style.width = `${Math.min(100, rms * 280)}%`;
    requestAnimationFrame(showLevel);
  };
  chunks = [];
  chunkTimes = [];
  recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "" });
  recorder.ondataavailable = (event) => { if (event.data.size) { chunks.push(event.data); chunkTimes.push(performance.now()); } };
  recorder.start(250);
  probe = { schemaVersion: 1, startedAt: new Date().toISOString(), permissionLatencyMs: performance.now() - permissionStarted, sampleRate: audioContext.sampleRate, mimeType: recorder.mimeType, settings: stream.getAudioTracks()[0]?.getSettings(), reference: elements.reference.value };
  elements.start.disabled = true;
  elements.stop.disabled = false;
  elements.output.textContent = JSON.stringify(probe, null, 2);
  showLevel();
};

elements.stop.onclick = () => {
  recorder.onstop = async () => {
    blob = new Blob(chunks, { type: recorder.mimeType });
    const intervals = chunkTimes.slice(1).map((time, index) => time - chunkTimes[index]);
    probe = { ...probe, stoppedAt: new Date().toISOString(), durationMs: chunkTimes.at(-1) - chunkTimes[0], chunks: chunks.length, bytes: blob.size, chunkIntervalMs: { min: Math.min(...intervals), max: Math.max(...intervals), average: intervals.reduce((a, b) => a + b, 0) / intervals.length } };
    elements.output.textContent = JSON.stringify(probe, null, 2);
    elements.play.disabled = elements.download.disabled = elements.export.disabled = false;
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
    elements.level.style.width = "0";
  };
  recorder.stop();
  elements.stop.disabled = true;
  elements.start.disabled = false;
};

elements.play.onclick = () => new Audio(URL.createObjectURL(blob)).play();
elements.download.onclick = () => download(blob, `ev-audio-${Date.now()}.webm`, blob.type);
elements.export.onclick = () => download(JSON.stringify(probe, null, 2), `ev-audio-${Date.now()}.json`, "application/json");
