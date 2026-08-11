import { createHash } from "node:crypto";
import { run } from "./process.mjs";

const FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{pane_active}";

export async function inventoryTmux() {
  const result = await run("tmux", ["list-panes", "-a", "-F", FORMAT]);
  const panes = result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [sessionId, sessionName, windowId, windowIndex, paneId, paneIndex, pid, command, path, dead, active] = line.split("\t");
    return { sessionId, sessionName, windowId, windowIndex: Number(windowIndex), paneId, paneIndex: Number(paneIndex), pid: Number(pid), command, path, dead: dead === "1", active: active === "1" };
  });
  return { panes, durationMs: result.durationMs };
}

export async function captureMetadata(paneId, lines = 80) {
  const result = await run("tmux", ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${lines}`]);
  return {
    paneId,
    durationMs: result.durationMs,
    byteLength: Buffer.byteLength(result.stdout),
    lineCount: result.stdout.split("\n").length,
    sha256: createHash("sha256").update(result.stdout).digest("hex")
  };
}
