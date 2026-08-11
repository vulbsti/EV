import { createHash } from "node:crypto";

const attentionPatterns = [
  { id: "permission", severity: "critical", label: "Permission required", regex: /(?:permission|approval).{0,50}(?:required|needed|requested|waiting)|(?:allow|approve)\s+(?:this|it|command|action)/i },
  { id: "confirmation", severity: "critical", label: "Confirmation requested", regex: /(?:do you want to|would you like to|are you sure|continue\?|proceed\?|\[(?:y\/n|Y\/n|y\/N)\]|\((?:y\/n|Y\/n|y\/N)\))/i },
  { id: "input", severity: "action", label: "Waiting for input", regex: /(?:press|hit)\s+(?:enter|return)|waiting for (?:your|user) input|choose (?:an option|one)|select (?:an option|one)/i },
  { id: "review", severity: "action", label: "Review requested", regex: /review (?:required|requested|changes|the)|ready for (?:your )?review/i },
  { id: "failure", severity: "warning", label: "Possible failure", regex: /(?:^|\s)(?:fatal|panic|uncaught|unhandled exception|tests? failed|build failed)(?:\s|:|$)/i }
];

export function stripTerminalControls(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function inspectAttention(content) {
  const lines = stripTerminalControls(content).split("\n").map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-24);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    for (const pattern of attentionPatterns) {
      if (pattern.regex.test(lines[index])) {
        return { required: true, id: pattern.id, severity: pattern.severity, label: pattern.label, evidence: lines[index].trim().slice(0, 240) };
      }
    }
  }
  return { required: false, id: null, severity: null, label: null, evidence: null };
}

export function terminalDigest(content) {
  return createHash("sha256").update(stripTerminalControls(content)).digest("hex");
}

export function redactCommandPreview(value) {
  return String(value)
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 160);
}
