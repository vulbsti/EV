import { ScopedWorkspace } from "../daemon/lib/scoped-workspace.mjs";

const workspacePromise = ScopedWorkspace.open(process.env.EV_WORKSPACE_ROOT ?? process.cwd());

function schema(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value };
}

export default function scopedTools(pi) {
  pi.registerTool({
    name: "workspace_read",
    label: "Read workspace file",
    description: "Read one bounded UTF-8 file inside the isolated task workspace.",
    parameters: schema({ path: { type: "string", description: "Workspace-relative file path" } }),
    async execute(_id, params) { return text(await (await workspacePromise).read(params.path)); }
  });
  pi.registerTool({
    name: "workspace_write",
    label: "Write workspace file",
    description: "Write one bounded UTF-8 file inside the isolated task workspace.",
    parameters: schema({ path: { type: "string" }, contents: { type: "string" } }),
    async execute(_id, params) { return text(await (await workspacePromise).write(params.path, params.contents)); }
  });
  pi.registerTool({
    name: "workspace_list",
    label: "List workspace",
    description: "List one directory inside the isolated task workspace.",
    parameters: schema({ path: { type: "string", default: "." } }, []),
    async execute(_id, params) { return text(await (await workspacePromise).list(params.path ?? ".")); }
  });
  pi.registerTool({
    name: "workspace_grep",
    label: "Search workspace",
    description: "Search bounded workspace files for a literal string.",
    parameters: schema({ pattern: { type: "string" }, path: { type: "string", default: "." } }, ["pattern"]),
    async execute(_id, params) { return text(await (await workspacePromise).grep({ pattern: params.pattern, path: params.path ?? "." })); }
  });
  pi.registerTool({
    name: "workspace_run",
    label: "Run sandboxed workspace command",
    description: "Run one allowlisted command inside a network-disabled Bubblewrap workspace sandbox.",
    parameters: schema({
      command: { type: "string" },
      args: { type: "array", items: { type: "string" }, default: [] },
      timeoutMs: { type: "integer", minimum: 1, maximum: 30000, default: 30000 }
    }, ["command"]),
    async execute(_id, params) { return text(await (await workspacePromise).run({ command: params.command, args: params.args ?? [], timeoutMs: params.timeoutMs ?? 30000 })); }
  });
}
