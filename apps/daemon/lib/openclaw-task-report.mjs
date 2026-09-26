function boundedText(value, max = 12_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function listOfText(value, maxItems = 8) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => boundedText(item, 700)).filter(Boolean) : [];
}

function parseObject(text) {
  const source = String(text ?? "").trim();
  const fenced = source.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1]?.trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  for (const candidate of [source, fenced, start >= 0 && end > start ? source.slice(start, end + 1) : null].filter(Boolean)) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* try the next report envelope */ }
  }
  return null;
}

export function validateOpenClawTaskReport(text, { needsSources = false, expectedAccount = null, strictEvidence = true } = {}) {
  const value = parseObject(text);
  if (!value) throw Object.assign(new Error("OpenClaw did not return a structured task report"), { code: "TASK_REPORT_INVALID" });
  const goal = boundedText(value.goal, 1_000);
  const answer = boundedText(value.answer);
  if (!goal || !answer) throw Object.assign(new Error("The task report is missing its interpreted goal or answer"), { code: "TASK_REPORT_INVALID" });
  const outcome = value.outcome ?? "completed";
  if (!["completed", "partial", "blocked"].includes(outcome)) throw Object.assign(new Error("The task report has an invalid outcome"), { code: "TASK_REPORT_INVALID" });
  const issues = [];
  const evidence = (Array.isArray(value.evidence) ? value.evidence : []).slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    let url;
    try { url = new URL(String(item.url)); } catch { return []; }
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || (url.protocol === 'file:' && url.hostname)) return [];
    return [{
      url: url.href,
      title: boundedText(item.title, 300),
      supports: boundedText(item.supports, 700),
      observedAt: boundedText(item.observedAt, 100),
      quotes: listOfText(item.quotes, 6).map((quote) => quote.slice(0, 500)),
      jsonPointers: listOfText(item.jsonPointers, 8).filter((pointer) => pointer.startsWith('/')).map((pointer) => pointer.slice(0, 160))
    }];
  });
  if (expectedAccount) {
    const account = expectedAccount.toLowerCase();
    for (const raw of answer.match(/https?:\/\/[^\s<>"”]+/g) ?? []) {
      let url;
      try { url = new URL(raw.replace(/[.,;!?)]*$/, "")); } catch { continue; }
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase()) ||
          !url.pathname.toLowerCase().startsWith(`/${account}/status/`) || evidence.some((item) => item.url === url.href)) continue;
      evidence.push({ url: url.href, title: `@${expectedAccount} post`, supports: "Direct post URL cited in the agent's answer", observedAt: "" });
      if (evidence.length >= 24) break;
    }
    evidence.sort((left, right) => {
      const direct = (item) => new URL(item.url).pathname.toLowerCase().startsWith(`/${account}/status/`);
      return Number(direct(right)) - Number(direct(left));
    });
  }
  if (needsSources && evidence.length === 0 && outcome !== "blocked") {
    issues.push("This research result has no inspectable source URL.");
  }
  if (expectedAccount) {
    const account = expectedAccount.toLowerCase();
    const matching = evidence.some(({ url }) => {
      const parsed = new URL(url);
      return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(parsed.hostname.toLowerCase()) &&
        parsed.pathname.toLowerCase().startsWith(`/${account}/status/`);
    });
    if (!matching && outcome !== "blocked") issues.push(`The result has no direct post link for @${expectedAccount}.`);
  }
  if (strictEvidence && issues.length) throw Object.assign(new Error(issues.join(" ")), { code: "TASK_EVIDENCE_MISSING" });
  return {
    goal,
    outcome,
    answer,
    evidence,
    deliverables: (Array.isArray(value.deliverables) ? value.deliverables : []).slice(0, 10).map((item) => ({ path: boundedText(item?.path, 1_000), title: boundedText(item?.title, 200) })).filter((item) => item.path),
    checks: listOfText(value.checks),
    limitations: listOfText(value.limitations),
    verification: {
      status: evidence.length ? "sources_supplied" : "reported_without_sources",
      issues,
      hostChecks: ["structured report", ...(needsSources ? ["sources present"] : []), ...(expectedAccount ? [`direct @${expectedAccount} post link present`] : [])]
    }
  };
}
