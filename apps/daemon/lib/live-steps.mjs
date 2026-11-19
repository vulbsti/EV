/**
 * Turns what an agent writes into its own transcript into steps a person can
 * follow: one thing it did, with a fixed id, a kind, a short label and a life
 * (running, then done). Labels come from code, never from a model. Commands
 * are sorted into read, list, search or run, the way Codex's command parser
 * gives "a human readable gist" of a shell line; the page folds a run of
 * reads and searches into one line.
 *
 * Only finished steps are kept (see AssistantSupervisor.recordLive). The step
 * that is still running is only the "now" line.
 */

const LABEL_MAX = 160;
const clip = (text, max = LABEL_MAX) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const fileOf = (path) => {
  const value = String(path ?? "").replace(/\/+$/, "");
  const parts = value.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : value;
};

/** Shell words, with quotes removed. Lossy on purpose: it only needs the gist. */
function words(line) {
  const found = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

// After a pipe these only shape the output; the command before them is what happened.
const FORMATTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "tr", "column", "less", "more", "cat", "nl", "grep", "rg", "awk", "jq", "xargs"]);
const READERS = new Set(["cat", "bat", "less", "more", "head", "tail", "nl"]);
const LISTERS = new Set(["ls", "tree", "find", "fd", "du"]);
const SEARCHERS = new Set(["rg", "grep", "ag", "ack"]);
// Flags whose next word is their value, not a path or a pattern.
const VALUE_FLAGS = {
  reader: new Set(["-n", "-c", "--lines", "--bytes"]),
  lister: new Set(["-maxdepth", "-mindepth", "-type", "-name", "-iname", "-path", "-d", "--depth", "-L"]),
  searcher: new Set(["-m", "--max-count", "-A", "-B", "-C", "-g", "--glob", "-t", "--type", "-e"])
};

/** What one segment of a command line does, or null when it is anything but reading, listing or searching. */
function actions(segment) {
  const [first, ...rest] = segment.split(/\s*\|\s*/);
  if (!rest.every((part) => FORMATTERS.has(words(part)[0]?.split("/").at(-1)))) return null;
  const argv = words(first);
  let name = argv[0]?.split("/").at(-1) ?? "";
  let args = argv.slice(1);
  if (["sudo", "env", "time", "nice"].includes(name)) return actions(args.join(" "));
  if (name === "git" && args[0] === "grep") { name = "rg"; args = args.slice(1); }
  const plain = (flags) => args.filter((arg, index) => !arg.startsWith("-") && !flags.has(args[index - 1]));
  if (READERS.has(name) || (name === "sed" && args.includes("-n"))) {
    const files = name === "sed" ? plain(new Set()).slice(1) : plain(VALUE_FLAGS.reader);
    return files.length ? files.map((target) => ({ kind: "read", target })) : null;
  }
  if (LISTERS.has(name) && !args.some((arg) => ["-exec", "-delete", "-execdir"].includes(arg))) return [{ kind: "list", target: plain(VALUE_FLAGS.lister)[0] ?? "." }];
  if (SEARCHERS.has(name)) {
    const found = plain(VALUE_FLAGS.searcher);
    const pattern = args[args.indexOf("-e") + 1];
    const query = args.includes("-e") ? pattern : found.shift();
    return query ? [{ kind: "search", query, target: found[0] ?? null }] : null;
  }
  return null;
}

/**
 * The gist of a shell command: [{ kind: read|list|search, target, query }],
 * or one { kind: "run" } when any part of it does something else.
 */
export function parseCommand(command) {
  let line = String(command ?? "").trim();
  const wrapped = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(line);
  if (wrapped) line = wrapped[2];
  const firstLine = line.split("\n")[0];
  const segments = firstLine.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean).filter((segment) => !/^cd(\s|$)/.test(segment));
  if (!segments.length || line.includes("\n")) return [{ kind: "run", command: clip(firstLine, 120) }];
  const gist = [];
  for (const segment of segments) {
    const found = actions(segment);
    if (!found) return [{ kind: "run", command: clip(firstLine, 120) }];
    for (const item of found) {
      const last = gist.at(-1);
      if (!last || last.kind !== item.kind || last.target !== item.target || last.query !== item.query) gist.push(item);
    }
  }
  return gist;
}

const TENSE = {
  read: ["Reading", "Read"], list: ["Listing", "Listed"], search: ["Searching for", "Searched for"], run: ["Running", "Ran"],
  write: ["Writing", "Wrote"], edit: ["Editing", "Edited"], web: ["Searching the web for", "Searched the web for"],
  open: ["Opening", "Opened"], browse: ["Using the browser", "Used the browser"]
};
const verb = (kind, running) => TENSE[kind][running ? 0 : 1];

function commandLabel(parsed, running) {
  return parsed.map((item) => {
    if (item.kind === "run") return `${verb("run", running)} ${item.command}`;
    if (item.kind === "search") return `${verb("search", running)} "${clip(item.query, 60)}"${item.target ? ` in ${fileOf(item.target)}` : ""}`;
    return `${verb(item.kind, running)} ${fileOf(item.target)}`;
  }).join(", ");
}

/** A tool call as the agent made it; OpenClaw may wrap tools found through tool_search in `tool_call`. */
function unwrap(part) {
  const wrapped = part.name === "tool_call" ? /(?:^|:)([a-z_]+)$/.exec(String(part.arguments?.id ?? ""))?.[1] : null;
  return wrapped ? { name: wrapped, args: part.arguments?.args ?? {} } : { name: String(part.name ?? "tool"), args: part.arguments ?? {} };
}

/** Kind and label of one tool call, in the tense its state calls for. */
export function describeCall({ name, args = {} }, running = false) {
  const path = args.path ?? args.file_path ?? args.file ?? args.filePath;
  switch (name) {
    case "exec": case "bash": case "shell": {
      if (!args.command) return { kind: "ran", label: running ? "Running a command" : "Ran a command" };
      const parsed = parseCommand(args.command);
      const kind = parsed.every((item) => item.kind === "read") ? "read" : parsed.every((item) => item.kind !== "run") ? "searched" : "ran";
      return { kind, label: clip(commandLabel(parsed, running)), parsed };
    }
    case "process": return { kind: "ran", label: running ? "Checking on a running command" : "Checked on a running command" };
    case "read": return { kind: "read", label: path ? `${verb("read", running)} ${fileOf(path)}` : running ? "Reading a file" : "Read a file", parsed: path ? [{ kind: "read", target: path }] : undefined };
    case "write": return { kind: "wrote", label: path ? `${verb("write", running)} ${fileOf(path)}` : running ? "Writing a file" : "Wrote a file", file: path };
    case "edit": case "apply_patch": return { kind: "wrote", label: path ? `${verb("edit", running)} ${fileOf(path)}` : running ? "Editing files" : "Edited files", file: path };
    case "web_search": return { kind: "web", label: clip(`${verb("web", running)} "${args.query ?? args.q ?? ""}"`) };
    case "web_fetch": return { kind: "web", label: clip(`${verb("open", running)} ${String(args.url ?? "a web page").replace(/^https?:\/\/(www\.)?/, "")}`) };
    case "browser": return { kind: "web", label: clip(`${verb("browse", running)}${args.url ? ` on ${String(args.url).replace(/^https?:\/\/(www\.)?/, "")}` : ""}`) };
    default: return { kind: "used", label: clip(`${running ? "Using" : "Used"} ${name.replace(/_/g, " ")}`) };
  }
}

/** The first sentence or line of what the agent said, as a label. */
function saidLabel(text) {
  const first = String(text).trim().split(/\n/)[0];
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
  return clip(sentence);
}

/**
 * Reads one run's transcript events as they arrive. `add` returns the steps
 * that finished in these events, oldest first, and the step running now.
 * Step ids are stable: the tool call's own id, or the transcript position.
 */
export class StepMaker {
  constructor({ runId = "run", now = () => new Date().toISOString() } = {}) {
    this.runId = runId;
    this.clock = now;
    this.open = new Map();
    this.count = 0;
    this.model = null;
  }

  _id(hint) { this.count++; return hint ? String(hint).slice(0, 120) : `${this.runId}:${this.count}`; }

  _close(step, at, failed = false) {
    this.open.delete(step.callId);
    const { callId, args, name, ...kept } = step;
    const described = describeCall({ name, args }, false);
    return { ...kept, kind: described.kind, label: described.label, ...(described.file ? { file: described.file } : {}), ...(described.parsed ? { parsed: described.parsed } : {}), endedAt: at, ...(failed ? { failed: true } : {}) };
  }

  add(events = []) {
    const done = [];
    for (const event of events) {
      const message = event?.message;
      if (event?.type !== "message" || !message) continue;
      const at = this.clock();
      if (message.role === "assistant") {
        if (message.model) this.model = message.provider ? `${message.provider}/${message.model}` : message.model;
        // A new turn of the model means every tool call before it has returned.
        for (const step of [...this.open.values()]) done.push(this._close(step, at));
        const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
        if (message.stopReason === "stop") { done.push({ id: this._id(), kind: "handed in", label: "Handed in its result", startedAt: at, endedAt: at }); continue; }
        if (text) done.push({ id: this._id(), kind: "said", label: saidLabel(text), startedAt: at, endedAt: at });
        for (const part of message.content ?? []) {
          if (part.type !== "toolCall") continue;
          const { name, args } = unwrap(part);
          const callId = part.id ?? this._id();
          this.open.set(callId, { id: this._id(part.id), callId, name, args, startedAt: at });
        }
      } else if (message.role === "toolResult") {
        const step = this.open.get(message.toolCallId);
        if (!step) continue;
        const exitCode = message.details?.exitCode;
        done.push(this._close(step, at, Boolean(message.isError) || (Number.isInteger(exitCode) && exitCode !== 0)));
      }
    }
    return { done, running: this.running() };
  }

  /** The step that started last and has not finished, labelled in the present tense. */
  running() {
    const step = [...this.open.values()].at(-1);
    if (!step) return null;
    const described = describeCall({ name: step.name, args: step.args }, true);
    return { id: step.id, kind: described.kind, label: described.label, startedAt: step.startedAt };
  }
}
