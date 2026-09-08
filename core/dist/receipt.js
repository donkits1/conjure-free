// The structured receipt cognition returns at the end of an attempt. Cold software acts on it; cognition never
// transitions anything itself. A missing or unparseable receipt is not success.
const FENCE = /```receipt\s*\n([\s\S]*?)\n```/g;
export function parseReceipt(text) {
    let raw = null;
    for (const m of text.matchAll(FENCE))
        raw = m[1] ?? null; // last fence wins
    if (raw === null) {
        const t = text.trim();
        if (t.startsWith("{") && t.endsWith("}"))
            raw = t;
    }
    if (raw === null)
        return { receipt: null, error: "no receipt block in final message" };
    let obj;
    try {
        obj = JSON.parse(raw);
    }
    catch (e) {
        return { receipt: null, error: `receipt is not JSON: ${e.message}` };
    }
    const outcome = obj.outcome;
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    switch (outcome) {
        case "done": {
            const ev = Array.isArray(obj.evidence) ? obj.evidence.filter((e) => !!e && typeof e === "object" && typeof e.kind === "string" && typeof e.locator === "string") : [];
            return { receipt: { outcome: "done", summary, evidence: ev }, error: null };
        }
        case "blocked":
            return { receipt: { outcome: "blocked", reason: String(obj.reason ?? "unspecified"), summary, clearsWhen: typeof obj.clearsWhen === "string" ? obj.clearsWhen : undefined }, error: null };
        case "judgment": {
            const j = obj.judgment;
            // Options are optional: an empty list is an open question the operator answers in their own words (Homework).
            // One option is not a choice; it is refused so cognition cannot smuggle a decision through as a question.
            const options = Array.isArray(j?.options) ? j.options.map(String).filter((o) => o.trim()) : [];
            if (!j || typeof j.question !== "string" || !j.question.trim() || options.length === 1)
                return { receipt: null, error: "judgment receipt needs a question and either no options (open question) or >=2 options" };
            return { receipt: { outcome: "judgment", summary, judgment: { kind: j.kind === "technical" ? "technical" : "product", question: j.question, options, recommended: typeof j.recommended === "string" ? j.recommended : undefined, context: typeof j.context === "string" ? j.context : undefined } }, error: null };
        }
        case "plan": {
            const kids = Array.isArray(obj.children) ? obj.children.filter((c) => !!c && typeof c === "object" && typeof c.title === "string" && typeof c.brief === "string") : [];
            if (!kids.length)
                return { receipt: null, error: "plan receipt has no children" };
            return { receipt: { outcome: "plan", summary, children: kids.map((k) => ({ title: k.title, brief: k.brief, acceptance: typeof k.acceptance === "string" && k.acceptance ? k.acceptance : "Done when the brief is satisfied and evidence is attached.", seat: typeof k.seat === "string" ? k.seat : undefined })) }, error: null };
        }
        case "verdict":
            if (typeof obj.pass !== "boolean")
                return { receipt: null, error: "verdict receipt needs boolean pass" };
            return { receipt: { outcome: "verdict", pass: obj.pass, summary }, error: null };
        default:
            return { receipt: null, error: `unknown outcome '${String(outcome)}'` };
    }
}
/** The instruction rendered into every brief so cognition knows how to return. */
export function receiptInstructions(role) {
    const common = `End your final message with exactly one fenced block tagged \`receipt\` containing JSON. Conjure's cold software reads that block; nothing else you say changes organizational state.`;
    if (role === "reviewer") {
        return `${common}\nShape: {"outcome":"verdict","pass":true|false,"summary":"one paragraph: what you checked and why it passes or fails"}`;
    }
    if (role === "planner" || role === "manager") {
        return `${common}\nShapes:\n- {"outcome":"plan","summary":"...","children":[{"title":"...","brief":"...","acceptance":"..."}]} to split this into smaller work\n- {"outcome":"done","summary":"...","evidence":[{"kind":"note","locator":"...","summary":"..."}]} if it needs no split\n- {"outcome":"judgment","summary":"...","judgment":{"kind":"product","question":"...","options":["...","..."],"recommended":"...","context":"..."}} only if a human decision is genuinely required\n- {"outcome":"blocked","reason":"...","summary":"...","clearsWhen":"..."} if you cannot proceed`;
    }
    return `${common}\nShapes:\n- {"outcome":"done","summary":"what you did","evidence":[{"kind":"commit|file|test|note","locator":"sha|path|command|text","summary":"..."}]}\n- {"outcome":"judgment","summary":"...","judgment":{"kind":"product|technical","question":"...","options":["...","..."],"recommended":"...","context":"..."}} only if a human must choose before you can finish; omit "options" for an open question the operator answers in their own words\n- {"outcome":"blocked","reason":"...","summary":"...","clearsWhen":"what would unblock this"} if you cannot proceed`;
}
//# sourceMappingURL=receipt.js.map