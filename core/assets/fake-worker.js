// Deterministic stand-in for a provider. Reads the brief on stdin and behaves according to [[fake: ...]] markers
// found in it. Used only by non-Vitest checks and fault injection; never registered unless CONJURE_FAKE_PROVIDER=1.
import fs from "node:fs";
import path from "node:path";

const brief = fs.readFileSync(0, "utf8");
const marker = /\[\[fake:\s*([^\]]+)\]\]/g;
const directives = [...brief.matchAll(marker)].map((m) => m[1].trim());
const role = /ROLE:\s*(\w+)/.exec(brief)?.[1] ?? "worker";
const sleepFor = directives.find((d) => d.startsWith("sleep "));
const emit = (obj) => process.stdout.write("Working...\n\n```receipt\n" + JSON.stringify(obj) + "\n```\n");

async function main() {
  if (sleepFor) await new Promise((r) => setTimeout(r, Number(sleepFor.slice(6)) || 1000));
  if (directives.includes("dump")) { process.stdout.write(brief); return; }
  const grep = directives.find((d) => d.startsWith("grep "));
  if (grep) { const needle = grep.slice(5).trim(); const seen = brief.split(grep).join("").includes(needle); process.stdout.write(seen ? `SEES ${needle}\n` : `NO ${needle}\n`); return; }
  if (directives.includes("crash")) process.exit(3);
  if (directives.includes("hang")) { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (directives.includes("contract") || brief.includes("THE ORDER, as the operator wrote it")) {
    return process.stdout.write("Understood. One question answered; here is what I would have Conjure accept.\n\n```contract\n" + JSON.stringify({ title: "Clarified order", brief: "Do the clarified thing. [[fake: done]]", acceptance: "The clarified thing exists.", seat: "builder" }) + "\n```\n");
  }
  if (directives.includes("workflow")) {
    return process.stdout.write("Proposed graph.\n\n```workflow\n" + JSON.stringify({ nodes: [{ id: "start", kind: "start", x: 40, y: 160 }, { id: "s1", kind: "seat", seat: "builder", x: 220, y: 140 }, { id: "r1", kind: "review", seat: "reviewer", x: 460, y: 140 }, { id: "ret", kind: "return", x: 700, y: 160 }], edges: [{ id: "e1", from: "start", to: "s1", when: "next" }, { id: "e2", from: "s1", to: "r1", when: "next" }, { id: "e3", from: "r1", to: "ret", when: "pass" }, { id: "e4", from: "r1", to: "s1", when: "fail" }] }) + "\n```\n");
  }
  if (directives.includes("noreceipt")) { process.stdout.write("I did some things but forgot to say how.\n"); return; }
  if (directives.includes("agenda") || brief.includes("You help the operator prepare a meeting")) {
    return process.stdout.write("Here is what I would bring.\n\n```agenda\n" + JSON.stringify({ questions: ["Which API version do they run?", "Who owns the rollout date?"], context: "We need their answer before the integration work can be scoped.", bring: ["current integration notes"] }) + "\n```\n");
  }
  if (role === "reviewer") {
    const fail = directives.includes("verdict fail");
    return emit({ outcome: "verdict", pass: !fail, summary: fail ? "Fails acceptance: the change does not cover the stated case." : "Meets acceptance; evidence checked." });
  }
  // Homework realism: ask once, then proceed with the operator's answer in the brief. `judgment-once` offers options;
  // `question` is open (no options). Both stop asking as soon as a decision is recorded on the work.
  const answered = brief.includes("DECISIONS THE OPERATOR HAS ALREADY MADE");
  if (directives.includes("judgment-once") && !answered) {
    return emit({ outcome: "judgment", summary: "Two reasonable designs; the operator must pick.", judgment: { kind: "product", question: "Should the widget default to compact or expanded?", options: ["compact", "expanded"], recommended: "compact", context: "Compact matches the existing list density." } });
  }
  if (directives.includes("question") && !answered) {
    return emit({ outcome: "judgment", summary: "One fact only the operator knows.", judgment: { kind: "product", question: "What is the launch codename?", context: "It goes in the banner." } });
  }
  const grepdone = directives.find((d) => d.startsWith("grepdone "));
  if (grepdone) { const needle = grepdone.slice(9).trim(); const seen = brief.split(grepdone).join("").includes(needle); return emit({ outcome: "done", summary: seen ? `SEES ${needle}` : `NO ${needle}`, evidence: [] }); }
  if (directives.includes("judgment")) {
    return emit({ outcome: "judgment", summary: "Two reasonable designs; the operator must pick.", judgment: { kind: "product", question: "Should the widget default to compact or expanded?", options: ["compact", "expanded"], recommended: "compact", context: "Compact matches the existing list density." } });
  }
  if (directives.includes("blocked")) {
    return emit({ outcome: "blocked", reason: "missing-input", summary: "The brief references a design file that does not exist in the workspace.", clearsWhen: "the design file is added to the workspace" });
  }
  const planN = directives.find((d) => /^plan(\s+\d+)?$/.test(d));
  if (planN) {
    const n = Number(planN.slice(4).trim()) || 2;
    const children = Array.from({ length: n }, (_, i) => ({ title: `Part ${String.fromCharCode(65 + i)}`, brief: `Do part ${String.fromCharCode(65 + i)}. [[fake: done]]`, acceptance: `${String.fromCharCode(65 + i)} exists` }));
    return emit({ outcome: "plan", summary: `Split into ${n} pieces.`, children });
  }
  // default: done; optionally touch a file in the workspace as evidence.
  const ev = [];
  if (directives.includes("write")) {
    const f = path.join(process.cwd(), "fake-output.txt");
    fs.writeFileSync(f, `written at ${new Date().toISOString()}\n`);
    ev.push({ kind: "file", locator: f, summary: "wrote fake-output.txt" });
  }
  emit({ outcome: "done", summary: "Completed the brief.", evidence: ev });
}
main();
