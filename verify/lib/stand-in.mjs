// A local stand-in for EV's model provider and for the agent runtime.
//
// EV under verification sends its model calls here (EV_MODEL_URL) and
// its workers are the stub in bin/openclaw, which asks here what to do. A
// check scripts both with plain functions, so a behaviour that depends on a
// decision ("EV1 searches, then answers") is tested without a real model.
import { createServer } from "node:http";
import {
  NotBuilt, TOOLS, decisionToday, dialectOf, learnerView, offeredTools, personMessage, roleOf, shownText,
  textResponse, today, toolCallResponse, toolResults, workerReport, workerTurnKind
} from "./protocol.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/**
 * script: { ev, planner, reviewer, learner, answer, worker } - each optional.
 * A role without a script gets a harmless default: EV1 replies "ok", the
 * planner uses one agent, the reviewer accepts, the learner changes nothing,
 * a worker finishes with "Done.".
 */
export async function startStandIn(script = {}) {
  const calls = [];
  const jobs = [];
  const notBuilt = [];
  const errors = [];
  const pending = new Map(); // tool call id -> the turn waiting for its result
  const outage = new Map(); // role -> HTTP status to answer with
  let callSeq = 0;

  /** Runs a role's script as a turn that can pause on tool calls. */
  function beginTurn(role, call, dialect) {
    const turn = { step: deferred(), steps: [], said: null };
    const toolMode = call.tools.length > 0;
    const useTool = async (intent, input) => {
      const tool = TOOLS[intent];
      if (!toolMode) {
        // Today's wire has no tools: EV1's actions ride on its one decision, and nothing else can be asked for.
        if (role !== "ev" || !["startWork", "messageTask"].includes(intent)) throw new NotBuilt(`${role === "ev" ? "EV1" : `the ${role}`} has no "${tool.name}" tool yet`);
        turn.steps.push({ intent, ...input });
        return { text: "", hits: [] };
      }
      if (!call.tools.includes(tool.name)) throw new NotBuilt(`${role} is not offered a "${tool.name}" tool`);
      const id = `call_${++callSeq}`;
      const result = deferred();
      pending.set(id, { turn, result });
      turn.step.resolve(toolCallResponse(dialect, { id, name: tool.name, args: tool.args(input) }));
      const text = await result.promise;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const hits = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.hits) ? parsed.hits : Array.isArray(parsed?.results) ? parsed.results : [];
      return { text, hits, value: parsed };
    };
    const api = {
      role, text: call.text, tools: call.tools, message: personMessage(call.text),
      search: (query) => useTool("search", { query }),
      read: (id) => useTool("read", { id }),
      remember: (text, { quote = null } = {}) => useTool("remember", { text, quote }),
      startWork: (work) => useTool("startWork", work),
      messageTask: (message) => useTool("messageTask", message),
      readFile: (path) => useTool("readFile", { path }),
      ask: (questions, { assumptions = [], lead = "One thing before I start:" } = {}) => { turn.steps.push({ intent: "ask", questions: [].concat(questions), assumptions }); return { final: true, said: lead }; },
      reply: (text) => ({ final: true, said: String(text) }),
      accept: (review = {}) => ({ final: true, review: { ...review, verdict: "accept" } }),
      revise: (review = {}) => ({ final: true, review: { ...review, verdict: "revise" } }),
      ...(role === "learner" ? learnerView(call.text) : {})
    };
    const finish = async () => {
      const handler = script[role];
      const out = handler ? await handler(api, control) : undefined;
      if (role === "ev") {
        const said = out?.said ?? (typeof out === "string" ? out : "ok");
        const ask = turn.steps.find((step) => step.intent === "ask");
        if (!toolMode) return textResponse(dialect, JSON.stringify(decisionToday({ steps: turn.steps, said, text: call.text })));
        if (ask && call.tools.includes(TOOLS.ask.name)) return toolCallResponse(dialect, { id: `call_${++callSeq}`, name: TOOLS.ask.name, args: TOOLS.ask.args(ask) });
        if (call.tools.includes(TOOLS.reply.name)) return toolCallResponse(dialect, { id: `call_${++callSeq}`, name: TOOLS.reply.name, args: TOOLS.reply.args({ text: said }) });
        return textResponse(dialect, said);
      }
      if (role === "planner") return textResponse(dialect, JSON.stringify(today.planner(out)));
      if (role === "reviewer") return textResponse(dialect, JSON.stringify(today.reviewer(out?.review ?? out)));
      if (role === "learner") return textResponse(dialect, JSON.stringify(today.learner((Array.isArray(out) ? out : out?.ops ?? []).filter(Boolean))));
      if (role === "answer") return textResponse(dialect, JSON.stringify(today.answer(out)));
      return textResponse(dialect, typeof out === "string" ? out : JSON.stringify(out ?? {}));
    };
    finish().then((response) => turn.step.resolve(response), (error) => {
      if (error instanceof NotBuilt) { notBuilt.push(error.what); call.notBuilt = error.what; }
      else errors.push(`${role} script: ${error.stack ?? error.message}`);
      // Something harmless, so EV carries on and the check fails on its own terms.
      turn.step.resolve(textResponse(dialect, role === "ev" && call.tools.length === 0 ? JSON.stringify({ action: "reply", message: "(stand-in: this turn needed something EV cannot do yet)" }) : "{}"));
    });
    return turn;
  }

  async function modelCall(request, response, path) {
    const dialect = dialectOf(path);
    const body = await readJson(request);
    const results = toolResults(dialect, body);
    // A request carrying the result of a tool call we issued continues that turn.
    const waitingId = [...results.keys()].find((id) => pending.has(id));
    if (waitingId) {
      const { turn, result } = pending.get(waitingId);
      pending.delete(waitingId);
      turn.step = deferred();
      result.resolve(results.get(waitingId));
      return send(response, 200, await turn.step.promise);
    }
    const text = shownText(dialect, body);
    const role = roleOf({ userAgent: request.headers["user-agent"], text });
    const call = { role, at: Date.now(), text, tools: offeredTools(dialect, body), body, session: request.headers["x-opencode-session"] ?? null };
    calls.push(call);
    const status = outage.get(role) ?? outage.get("*");
    if (status) { call.refused = status; return send(response, status, { error: "stand-in outage" }); }
    const turn = beginTurn(role, call, dialect);
    send(response, 200, await turn.step.promise);
  }

  async function workerJob(request, response) {
    const job = await readJson(request);
    job.kind = workerTurnKind(job.prompt ?? "");
    job.at = Date.now();
    job.run = jobs.filter((earlier) => earlier.taskId === job.taskId).length + 1;
    jobs.push(job);
    const helpers = {
      ...job,
      done: (answer = "Done.", extra = {}) => ({ text: workerReport({ answer, ...extra }), files: extra.files ?? {}, ...extra.process }),
      needsInput: (question, answer = "Waiting for an answer.") => ({ text: workerReport({ answer, outcome: "needs_input", question }) })
    };
    let plan;
    try { plan = script.worker ? await script.worker(helpers, control) : helpers.done(); }
    catch (error) { errors.push(`worker script: ${error.stack ?? error.message}`); plan = helpers.done(); }
    if (typeof plan === "string") plan = helpers.done(plan);
    job.plan = plan;
    send(response, 200, plan ?? helpers.done());
  }

  function send(response, status, value) {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://stand-in").pathname;
    const handled = request.method !== "POST" ? null
      : path === "/worker" ? workerJob(request, response)
        : dialectOf(path) ? modelCall(request, response, path) : null;
    if (!handled) return send(response, 404, { error: `stand-in has no ${request.method} ${path}` });
    handled.catch((error) => { errors.push(error.stack ?? error.message); send(response, 500, { error: error.message }); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const control = {
    url: `http://127.0.0.1:${server.address().port}`,
    script,
    /** Every model call EV made, oldest first, optionally for one role. */
    calls: (role = null) => role ? calls.filter((call) => call.role === role) : calls,
    /** Every turn a worker was started for, oldest first. */
    jobs: (taskId = null) => taskId ? jobs.filter((job) => job.taskId === taskId) : jobs,
    notBuilt, errors,
    /** Makes model calls for a role (or "*") fail with this HTTP status until restored. */
    outage: (role = "*", status = 503) => { outage.set(role, status); },
    restore: (role = null) => { if (role) outage.delete(role); else outage.clear(); },
    async stop() { server.closeAllConnections?.(); await new Promise((done) => server.close(done)); }
  };
  return control;
}

/** A switch a script can wait on, so a check decides when a held step goes on. */
export function gate() {
  const { promise, resolve } = deferred();
  let reached; const arrival = new Promise((done) => { reached = done; });
  return {
    /** Called inside a script: marks the step as reached and waits to be let through. */
    async wait() { reached(); await promise; },
    /** Resolves once a script is waiting at the gate. */
    reached: arrival,
    open: resolve
  };
}
