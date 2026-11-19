import { execFile, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Where KenWise runs, and what an agent's container sees of the machine.
 *
 * `EV_PLACE` is `local` (the person's own computer, the default) or `cloud`
 * (a machine they rent). The place only sets defaults; the code is the same:
 *
 * - local: the person's home (and any extra read roots) is mounted into
 *   every agent's container read-only at its real path; the secret places
 *   below are hidden; nothing outside the work's own folders is writable
 *   unless the person granted it.
 * - cloud: none of the machine's home is shown; one work folder
 *   (EV_WORK_FOLDER, default ~/work) is writable for all work.
 *
 * Grants are kept in the `files` setting and are written only from the
 * person: the page (Settings, Files) or their own words to EV (the `grant`
 * tool checks the words are in their message). Mounts are fixed when an
 * agent's turn starts, so a changed grant reaches running work at its next
 * step, when EV stops it there and resumes the same session.
 */

export const PLACES = ["local", "cloud"];

export function placeFromEnv(env = process.env) {
  const place = String(env.EV_PLACE ?? "local").trim().toLowerCase();
  if (!PLACES.includes(place)) throw Object.assign(new Error(`EV_PLACE must be local or cloud, not "${env.EV_PLACE}"`), { code: "INVALID_PLACE" });
  return place;
}

/**
 * Secret places under the home that agents never see, even though they can
 * read the rest of it. A list, so the person can add to it in settings.
 */
export const DEFAULT_HIDDEN = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
  ".config/gh", ".config/hub", ".password-store", ".local/share/keyrings", "Library/Keychains",
  ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/1Password", ".config/Bitwarden",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge", "Library/Safari", "Library/Cookies", "Library/Group Containers/2BUA8C4S2C.com.1password",
  ".claude", ".claude.json", ".codex", ".config/opencode", ".local/share/opencode", ".openclaw", ".pi",
  ".bash_history", ".zsh_history", ".python_history", ".node_repl_history", ".local/share/fish/fish_history"
];

/** Inside a folder the agent may write, these files are hidden too (project secrets). */
const PROJECT_SECRETS = /^\.env(\..+)?$/;
const PROJECT_SECRETS_KEEP = /\.(example|sample|template|dist)$/;
const SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);

export const SCOPES = ["always", "goal", "work"];

const expandHome = (path, home) => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };
const real = (path) => { try { return realpathSync(path); } catch { return null; } };

/** A folder the person names, as an absolute real path, or an error saying why not. */
export function folderPath(input, { home = homedir() } = {}) {
  const text = String(input ?? "").trim();
  if (!text) throw Object.assign(new Error("A folder is required"), { code: "INVALID_FOLDER" });
  const path = resolve(expandHome(text, home));
  if (!isAbsolute(expandHome(text, home))) throw Object.assign(new Error(`Name the folder by its full path, such as ~/proj/site, not "${text}"`), { code: "INVALID_FOLDER" });
  const found = real(path);
  if (!found) throw Object.assign(new Error(`${path} does not exist`), { code: "NO_SUCH_FOLDER" });
  if (!lstatSync(found).isDirectory()) throw Object.assign(new Error(`${path} is a file, not a folder`), { code: "INVALID_FOLDER" });
  if (found === "/" ) throw Object.assign(new Error("The whole disk cannot be made writable"), { code: "INVALID_FOLDER" });
  return found;
}

/** The person's file settings with defaults filled in. */
export function fileSettings(saved) {
  const value = saved && typeof saved === "object" ? saved : {};
  const strings = (list) => Array.isArray(list) ? list.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  return {
    readRoots: strings(value.readRoots),
    hidden: strings(value.hidden),
    grants: Array.isArray(value.grants) ? value.grants.filter((grant) => grant && typeof grant.path === "string" && SCOPES.includes(grant.scope)) : []
  };
}

/** A new grant record. `source` is where the person said it: "settings" or message:… */
export function newGrant({ path, scope = "always", workId = null, goal = null, source }) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error(`scope must be one of ${SCOPES.join(", ")}`), { code: "INVALID_SCOPE" });
  if (scope === "work" && !workId) throw Object.assign(new Error("A grant for one piece of work needs the work"), { code: "INVALID_SCOPE" });
  if (scope === "goal" && !goal) throw Object.assign(new Error("A grant for one goal needs a piece of work under that goal"), { code: "INVALID_SCOPE" });
  return { id: randomUUID(), path, scope, ...(workId ? { workId } : {}), ...(goal ? { goal } : {}), source, at: new Date().toISOString() };
}

/** The goal a piece of work belongs to: the folder its shared workspace sits in, or the work itself. */
export function goalOf(task) {
  const shared = task?.input?.sharedWorkspace;
  return shared ? String(shared).split("/")[0] : task?.taskId ?? null;
}

/** The grants that apply to one piece of work. */
export function grantsFor(grants, task) {
  const goal = goalOf(task);
  return grants.filter((grant) => grant.scope === "always" || (grant.scope === "work" && grant.workId === task?.taskId) || (grant.scope === "goal" && grant.goal === goal));
}

/** `.env` files in a writable folder, a few levels down, skipping dependency folders. */
function projectSecrets(root, depth = 3) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= 200) return;
      const path = join(dir, entry.name);
      if (entry.isFile() && PROJECT_SECRETS.test(entry.name) && !PROJECT_SECRETS_KEEP.test(entry.name)) found.push(path);
      else if (entry.isDirectory() && level < depth && !SCAN_SKIP.has(entry.name)) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Places that stay read-only inside a folder agents may change: KenWise's own
 * program, and what the person's shell or desktop runs at start. An agent that
 * could change them could give itself everything at the next start.
 */
export const START_FILES = [
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".config/fish",
  ".local/bin", "bin", ".config/autostart", ".config/systemd", "Library/LaunchAgents", ".ssh", ".gitconfig", ".config/git"
];

/**
 * What one agent's container sees of this machine, for one turn:
 * `read` folders mounted read-only, `write` folders read-write, `readOnly`
 * places inside a writable folder kept read-only, and `hiddenDirs` and
 * `hiddenFiles` covered by an empty folder or an empty file. Only paths that
 * exist are named (a mount point cannot be made inside a read-only folder).
 * `privatePaths` (KenWise's settings file and data) are always hidden;
 * `programPaths` (KenWise's code) are always read-only. In the cloud the
 * stored grants are not used: every work may change the work folder.
 */
export function containerFiles({ place, settings, task, home = homedir(), privatePaths = [], programPaths = [], workFolder = null }) {
  const files = fileSettings(settings);
  const read = place === "local" ? [...new Set([home, ...files.readRoots.map((root) => real(resolve(expandHome(root, home))))].filter(Boolean))] : [];
  const granted = place === "local" ? grantsFor(files.grants, task).map((grant) => real(grant.path)).filter(Boolean) : [];
  if (place === "cloud" && workFolder) { mkdirSync(workFolder, { recursive: true }); granted.push(real(workFolder)); }
  const write = [...new Set(granted)];
  const seen = (path) => read.some((root) => inside(root, path)) || write.some((root) => inside(root, path));
  const hiddenDirs = [];
  const hiddenFiles = [];
  const hide = (path) => {
    const found = real(path);
    if (!found || !seen(found)) return;
    (lstatSync(found).isDirectory() ? hiddenDirs : hiddenFiles).push(found);
  };
  if (read.length) for (const name of [...DEFAULT_HIDDEN, ...files.hidden]) for (const root of read) hide(isAbsolute(expandHome(name, home)) ? expandHome(name, home) : join(root, name));
  for (const path of privatePaths) hide(path);
  for (const root of write) for (const path of projectSecrets(root)) hide(path);
  // A hidden folder wins over a grant inside it: the grant is dropped, not the hiding.
  const writable = write.filter((path) => !hiddenDirs.some((dir) => inside(dir, path)));
  const readOnly = [...new Set([...programPaths, ...START_FILES.map((name) => join(home, name))].map(real).filter(Boolean))]
    .filter((path) => writable.some((root) => inside(root, path)) && !hiddenDirs.some((dir) => inside(dir, path)) && !hiddenFiles.includes(path));
  // A folder both read and granted is mounted once, writable.
  return { read: read.filter((path) => !writable.includes(path)), write: writable, readOnly, hiddenDirs: [...new Set(hiddenDirs)], hiddenFiles: [...new Set(hiddenFiles)] };
}

/**
 * The `--mount` arguments for those files. Docker orders nested mounts by
 * depth itself. Docker reads each --mount as one CSV record, so every field
 * that holds a path is quoted: a comma or quote in a folder's name cannot add
 * or change a key (a later key wins, so `dst=` in a name would move a mount).
 * Podman splits on commas without quoting, so there a path holding a comma or
 * a quote stops the run. A line break or NUL stops it everywhere.
 */
export function mountArgs({ read = [], write = [], readOnly = [], hiddenDirs = [], hiddenFiles = [] } = {}, cli = "docker") {
  const podman = isPodman(cli);
  const field = (key, path) => {
    if (/[\0\r\n]/.test(path) || (podman && /[,"]/.test(path))) {
      throw Object.assign(new Error(`The agent cannot be started safely: the path ${JSON.stringify(path)} cannot be given to ${podman ? "podman" : "the container"} as written. Rename it, or take it out of the folders KenWise shows agents.`), { code: "UNSAFE_PATH" });
    }
    return podman ? `${key}=${path}` : `"${`${key}=${path}`.replaceAll('"', '""')}"`;
  };
  const bind = (path, readonly) => ["--mount", ["type=bind", field("src", path), field("dst", path), ...(readonly ? ["readonly"] : [])].join(",")];
  return [
    ...read.flatMap((path) => bind(path, true)),
    ...write.flatMap((path) => bind(path, false)),
    ...readOnly.flatMap((path) => bind(path, true)),
    ...hiddenDirs.flatMap((path) => ["--mount", ["type=tmpfs", field("dst", path), "tmpfs-mode=0500"].join(",")]),
    ...hiddenFiles.flatMap((path) => ["--mount", ["type=bind", "src=/dev/null", field("dst", path), "readonly"].join(",")])
  ];
}

/** What an agent is told about its files, in the brief. `contained` is false when agents run on the machine itself. */
export function filesNote({ place, contained = true, read = [], write = [] }, home = homedir()) {
  const show = (path) => path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  if (!contained) return "You run directly on the person's machine, as them, with no container: nothing stops you reading or changing their files, so change files only in your workspace unless the brief says otherwise, and never touch their keys, credentials or KenWise's own files.";
  const lines = [];
  if (place === "local") lines.push(`You run in your own container: install and run whatever you need, it is yours. The person's files are visible at their real paths, read-only: ${read.map(show).join(", ")}. Some secret places (keys, browser profiles, credentials) are hidden.`);
  else lines.push("You run in your own container on a machine the person rents for this: install and run whatever you need.");
  lines.push(write.length ? `Besides your workspace and home, you may change files in: ${write.map(show).join(", ")}.` : "You may change files only in your workspace and home.");
  if (place === "local") lines.push("To change something in a folder you can only read, do not wait: copy what you need into your workspace and do the work there. In your answer say where the result belongs on the person's computer and what would change there, and list the changed copies under deliverables, so EV can ask them to apply it.");
  return lines.join(" ");
}

/** What EV is shown about files, so it can judge when work needs a folder made writable. */
export function filesPicture({ place, contained = true, settings, home = homedir() }) {
  const files = fileSettings(settings);
  const show = (path) => path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  if (!contained) return "Agents run directly on this machine with no container (a testing setup): nothing limits what they read or change, and grants change nothing.";
  if (place === "cloud") return "KenWise runs on a cloud machine the person rents. Agents cannot see the person's own computer; they share one work folder on the machine and can change it.";
  const grants = files.grants.map((grant) => `${show(grant.path)} (${grant.scope === "always" ? "always" : grant.scope === "goal" ? `for the goal of work:${grant.workId ?? "?"}` : `for work:${grant.workId}`})`);
  return `KenWise runs on the person's own computer. Agents can read their files but change only their own workspace${grants.length ? ` and these folders: ${grants.join(", ")}` : ""}. Use grant when they let you change a folder; without a grant, agents work on a copy and the person is asked to apply it.`;
}

/** The container command line (docker, or podman), from EV_CONTAINER_CLI or what is installed. */
let foundCli = null;
export function containerCli(env = process.env) {
  if (env.EV_CONTAINER_CLI) return env.EV_CONTAINER_CLI;
  if (foundCli) return foundCli;
  for (const name of ["docker", "podman"]) {
    try { execFileSync(name, ["--version"], { stdio: "ignore" }); return (foundCli = name); } catch {}
  }
  return "docker";
}

/** True when the CLI is podman, which needs keep-id so files the agent writes stay the person's. */
export const isPodman = (cli) => /(^|\/)podman$/.test(cli);

/**
 * Why agents cannot be started in a container right now, in the person's
 * terms, or null when the runtime answers. Asked again at most once a minute.
 */
let probed = { at: 0, problem: null, cli: null };
export async function containerProblem(cli) {
  if (probed.cli === cli && Date.now() - probed.at < 60_000) return probed.problem;
  const problem = await new Promise((done) => {
    execFile(cli, ["info"], { timeout: 15_000 }, (error) => {
      if (!error) return done(null);
      if (error.code === "ENOENT") return done(`No docker or podman is installed, and KenWise runs every agent in a container of its own. Install Docker Desktop, OrbStack or Colima on a Mac, Docker Engine or Podman on Linux, then run: kenwise update`);
      done(`${cli} is installed but not answering (is it running, and may your user use it?). Start it, then the work carries on.`);
    });
  });
  probed = { at: Date.now(), problem, cli };
  return problem;
}

/**
 * The files setup for one KenWise: what agents see, and the grants. Grants
 * and lists live in the `files` setting of the store. `changed(grant, how)`
 * is called after a grant is added or taken back, so running work it covers
 * can be told at its next step. `contained` is false when agents run on the
 * machine itself (EV_OPENCLAW_SANDBOX=host), so nothing here is enforced.
 */
export function createFiles({ store, place = placeFromEnv(), contained = true, home = homedir(), privatePaths = [], programPaths = [], workFolder = join(home, "work"), changed = () => {} }) {
  const settings = () => fileSettings(store.setting("files"));
  const save = (value) => store.saveSetting("files", value);
  const show = (path) => path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  const refuse = (message, code = "NOT_GRANTABLE") => { throw Object.assign(new Error(message), { code }); };
  const api = {
    place,
    home,
    contained,
    settings,
    forTask: (task) => containerFiles({ place, settings: settings(), task, home, privatePaths, programPaths, workFolder: place === "cloud" ? workFolder : null }),
    note: (task) => filesNote({ place, contained, ...api.forTask(task) }, home),
    picture: () => filesPicture({ place, contained, settings: settings(), home }),
    /** What the page shows: the place, read roots, hidden list and grants, with paths as the person writes them. */
    view({ runtime = null } = {}) {
      const files = settings();
      return {
        place,
        home,
        contained,
        runtime,
        readRoots: place === "local" ? [home, ...files.readRoots] : [],
        defaultHidden: place === "local" ? DEFAULT_HIDDEN : [],
        hidden: files.hidden,
        workFolder: place === "cloud" ? workFolder : null,
        grants: place === "local" ? files.grants.map((grant) => ({ ...grant, shown: show(grant.path) })) : []
      };
    },
    /** The grants made on the words of one of the person's messages, as the conversation shows them. */
    grantsFrom(messageId) {
      return settings().grants.filter((grant) => grant.source === `message:${messageId}`).map((grant) => ({ id: grant.id, shown: show(grant.path), scope: grant.scope }));
    },
    /**
     * Checks a grant could be made and returns the folder as shown; throws why
     * not. `fromWords` is a grant on the person's words to EV: the home and the
     * read roots can only be granted with their own click on the Files screen.
     */
    check({ folder, scope = "always", task = null, fromWords = false }) {
      if (place === "cloud") refuse(`On a cloud machine every piece of work can already change ${show(workFolder)}; grants are for your own computer.`, "NOT_NEEDED");
      const path = folderPath(folder, { home });
      const hidden = DEFAULT_HIDDEN.concat(settings().hidden).map((name) => real(isAbsolute(expandHome(name, home)) ? expandHome(name, home) : join(home, name))).filter(Boolean);
      if (hidden.some((secret) => inside(secret, path))) refuse(`${show(path)} is one of the hidden secret places, so it cannot be made writable`, "HIDDEN_FOLDER");
      const own = [...privatePaths, ...programPaths].map(real).filter(Boolean);
      if (own.some((dir) => inside(dir, path))) refuse(`${show(path)} is part of KenWise itself, so agents cannot be given it`, "HIDDEN_FOLDER");
      if (fromWords) {
        const roots = [home, ...settings().readRoots].map(real).filter(Boolean);
        if (roots.includes(path) || own.some((dir) => inside(path, dir))) refuse(`${show(path)} is too wide to grant from a message: it holds KenWise itself or a whole place agents read. The person can allow it with their own click under Settings, Files.`, "TOO_WIDE");
      }
      newGrant({ path, scope, workId: task?.taskId ?? null, goal: scope === "goal" ? goalOf(task) : null, source: "check" });
      return show(path);
    },
    changed,
    /** Adds a grant the person made. `source` is "settings" or the message:… they said it in. */
    grant({ folder, scope = "always", task = null, source, notify = true }) {
      api.check({ folder, scope, task, fromWords: source !== "settings" });
      const path = folderPath(folder, { home });
      const files = settings();
      const record = newGrant({ path, scope, workId: task?.taskId ?? null, goal: scope === "goal" ? goalOf(task) : null, source });
      const same = files.grants.find((grant) => grant.path === path && grant.scope === scope && (grant.workId ?? null) === (record.workId ?? null) && (grant.goal ?? null) === (record.goal ?? null));
      if (same) return { grant: same, added: false };
      save({ ...files, grants: [...files.grants, record] });
      if (notify) changed(record, "granted");
      return { grant: record, added: true };
    },
    revoke(id) {
      const files = settings();
      const grant = files.grants.find((item) => item.id === id);
      if (!grant) return null;
      save({ ...files, grants: files.grants.filter((item) => item.id !== id) });
      changed(grant, "revoked");
      return grant;
    },
    /** A grant for one piece of work ends when that work is delivered. */
    endWork(taskId) {
      const files = settings();
      const kept = files.grants.filter((grant) => !(grant.scope === "work" && grant.workId === taskId));
      if (kept.length !== files.grants.length) save({ ...files, grants: kept });
    },
    /** The person's extra read roots and hidden places. */
    saveLists({ readRoots, hidden }) {
      const files = settings();
      const roots = readRoots === undefined ? files.readRoots : readRoots.map((root) => folderPath(root, { home }));
      save({ ...files, readRoots: roots, hidden: hidden === undefined ? files.hidden : fileSettings({ hidden }).hidden });
      return api.view();
    }
  };
  return api;
}
