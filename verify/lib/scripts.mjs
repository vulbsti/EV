// Small building blocks for scripting the stand-in model in checks.

// Picks what EV1 does by what the person just wrote: on([pattern, handler], ...). First match wins.
export function on(...routes) {
  return async (turn, control) => {
    for (const [pattern, handler] of routes) if (pattern.test(turn.message)) return handler(turn, control);
    return turn.reply("ok");
  };
}

/** EV1 hands the message to an agent as one task. */
export const work = (title, said = "On it.") => async (turn) => {
  await turn.startWork({ title, request: turn.message });
  return turn.reply(said);
};

/** EV1 passes the message on to work it already started. */
export const passOn = (title, said = "Passed on.") => async (turn) => {
  await turn.messageTask({ task: title, text: turn.message });
  return turn.reply(said);
};

/** The texts of EV's result and question messages in a conversation. */
export async function said(ev, conversation = "main") {
  return (await ev.conversation(conversation)).filter((message) => message.role === "assistant").map((message) => message.content);
}

/**
 * Takes one task into its second round (the reviewer has asked for `missing`),
 * then crashes EV while the agent is revising and starts EV again. Returns
 * what the checks about restarts need to look at.
 */
export async function crashMidRevision({ start, gate, env = {}, missing = "The pricing table is missing.", usage = undefined, acceptAfter = 2, agentSurvives = false }) {
  const hold = gate();
  const reviews = [];
  let restarted = false;
  const ev = await start({ env, script: {
    ev: work("Pricing plan"),
    worker: async (job) => {
      if (job.kind === "revision" && !restarted) await hold.wait();
      return { ...job.done(`Attempt ${job.run}.`), ...(usage ? { usage } : {}) };
    },
    reviewer: (turn) => { reviews.push(turn.text); return reviews.length < acceptAfter ? turn.revise({ missing: [missing], feedback: [missing] }) : turn.accept({ handoff: "The pricing plan is ready." }); }
  } });
  const { taskId } = await ev.say("write the pricing plan");
  await hold.reached;
  const before = ev.standIn.jobs(taskId).length;
  // Usually the agent that was mid-revision dies with the machine. With
  // agentSurvives only EV crashes, and its agent process is left running.
  const agentPid = ev.standIn.jobs(taskId).at(-1).pid;
  if (!agentSurvives) try { process.kill(agentPid, "SIGKILL"); } catch {}
  restarted = true;
  await ev.restart({ crash: true });
  return { ev, taskId, reviews, jobsBefore: before, agentPid };
}

/**
 * EV1 looks something up the way it would with real tools: search, and if the
 * answer is not in the hits themselves, open the hits one by one. Returns the
 * text in which `wanted` was found, or null. Says "not built" until EV1 can search.
 */
export async function lookUp(turn, query, wanted) {
  const found = await turn.search(query);
  if (found.text.includes(wanted)) return found.text;
  for (const hit of found.hits.slice(0, 5)) {
    const id = hit?.id ?? hit?.key ?? hit?.ref;
    if (!id) continue;
    const opened = await turn.read(id);
    if (opened.text.includes(wanted)) return opened.text;
  }
  return null;
}

/** A learner that remembers a stated detail and forgets it when asked to. */
export const remembersAndForgets = (marker, memory) => (turn) => [turn.stated(marker, "fact", memory), turn.forgotten("forget", marker)];
