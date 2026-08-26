// selftest.mjs — one-command health check, fully self-contained: it builds a synthetic memory corpus in a temp
// directory and runs every assertion against that, so it works on a fresh clone with no real memory data.
//   node selftest.mjs
// Exits 0 with "ALL PASS" or 1 listing every failed assertion. Touches nothing outside its temp sandbox.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX = join(tmpdir(), "memory-cube-selftest");
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(SANDBOX, "mem"), { recursive: true });
process.env.CLAUDE_MEMORY_DIR = join(SANDBOX, "mem");   // must be set BEFORE importing recall.mjs

// ── synthetic corpus ─────────────────────────────────────────────────────────
const mem = (name, description, body, extra = "") => writeFileSync(join(SANDBOX, "mem", name + ".md"),
  `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: project\n  source: firsthand\n${extra}---\n\n${body}\n`);
mem("editor-history", "Used the Vega editor for the parser project until the 2026 switch", "Long-form notes about Vega.", "  validFrom: 2025-06-01T00:00:00Z\n  validTo: 2026-02-01T00:00:00Z\n");
mem("editor-current", "Switched the parser project to the Lumen editor", "Lumen replaced Vega on 2026-02-01.", "  validFrom: 2026-02-01T00:00:00Z\n");
mem("deploy-runbook", "Deploy runbook — one deployStop() helper, every surface calls it", "The stop path must never fork.");
mem("weekend-plans", "Notes about weekend hiking plans", "Trail options and drive times.");
writeFileSync(join(SANDBOX, "mem", "MEMORY.md"), "# Memory index\n");

let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// 1 — engine modules load
let makeCubeRecall, makeRecallBoundary, temperament;
try {
  ({ makeCubeRecall } = await import("./engine/cubeRecall.js"));
  ({ makeRecallBoundary } = await import("./engine/recallBoundary.js"));
  temperament = await import("./engine/temperament.js");
  const { createRequire } = await import("node:module");
  const LexCore = createRequire(import.meta.url)("./engine/lexcore.cjs");
  check("engine modules load", !!(makeCubeRecall && makeRecallBoundary && temperament.projectDials && LexCore.make));
} catch (e) { check("engine modules load", false, e.message); }

// 2 — corpus loads, ranking + as-of
let recall;
try {
  recall = await import("./recall.mjs");
  check("fixture corpus loads", recall.loadPoints().length === 4);
  const now = await recall.runQuery("which editor does the parser project use", { k: 2 });
  check("ranking: current editor wins today", now[0] && now[0].id === "editor-current", now.map((h) => h.id).join(","));
  const past = await recall.runQuery("which editor does the parser project use", { k: 2, asOf: Date.parse("2025-12-01") });
  check("as-of: past view returns the old editor", past[0] && past[0].id === "editor-history", past.map((h) => h.id).join(","));
} catch (e) { check("fixture corpus loads", false, e.message); }

// 3 — tombstone round-trip (state persists in state/boundary.json; fully reversed)
try {
  let eng = recall.makeEngine();
  const before = eng.boundary.isTombstoned("deploy-runbook");
  eng.boundary.tombstone("deploy-runbook"); eng.saveBoundary();
  const gone = !(await recall.runQuery("deploy stop helper runbook", { k: 4 })).some((h) => h.id === "deploy-runbook");
  eng = recall.makeEngine();
  const persisted = eng.boundary.isTombstoned("deploy-runbook");
  eng.boundary.untombstone("deploy-runbook"); eng.saveBoundary();
  const back = (await recall.runQuery("deploy stop helper runbook", { k: 4 })).some((h) => h.id === "deploy-runbook");
  check("tombstone: unreachable, persisted, reversible", !before && gone && persisted && back);
} catch (e) { check("tombstone round-trip", false, e.message); }

// 4 — compartment routing matrix
let compilerMod;
try {
  const { makeRouter } = await import("./compartments.mjs");
  const r = makeRouter();
  const cases = [
    ["loves dirty talk", "intimate", false],
    ["edge me and deny it", "intimate", false],                    // stock category allowlist
    ["terse replies please", null, false],                          // affirm_yes("please") must NOT route
    ["diagnosed with hypertension last spring", "medical", false],
    ["vent: the importer wasted my evening", "vent", false],        // prefix rule type
    ["budget tracking helps me focus", "finances", true],           // ambiguous -> ask
    ["be explicit about errors", "intimate", true],                 // ambiguous -> ask
    ["prefers naming the uncomfortable finding first", null, false] // L0 safety word must NOT route
  ];
  let ok = true, why = "";
  for (const [text, route, ask] of cases) {
    const a = r.analyze(text);
    if (a.route !== route || a.ask !== ask) { ok = false; why += `[${text} -> ${a.route}/${a.ask} wanted ${route}/${ask}] `; }
  }
  check("routing matrix (8 cases)", ok, why);
  const routed = r.routeItems(["be explicit about errors"], { "be explicit about errors": "public" });
  check("routing: stored override wins", routed.pub.length === 1 && !routed.pending.length);

  // 5 — compile split
  compilerMod = await import("./compile-persona.mjs");
  const c = compilerMod.compile({ name: "T", traits: ["loves dirty talk", "diagnosed with hypertension", "terse replies please"], hardLines: ["no degradation play"], voiceNotes: "" });
  check("compile: sealed text absent from public file",
    !c.markdown.includes("dirty talk") && !c.markdown.includes("hypertension") && c.markdown.includes("terse replies please") &&
    c.sealedDocs.intimate?.markdown.includes("dirty talk") && c.sealedDocs.medical?.markdown.includes("hypertension"));
  check("compile: counts coherent", c.sealedCount === Object.values(c.counts).reduce((a, b) => a + b, 0) && c.counts.intimate === 2 && c.counts.medical === 1);
  check("compile: sealed docs carry scope frontmatter", /scope: sealed-intimate/.test(c.sealedDocs.intimate.markdown));

  // 6 — scope gates end-to-end on a second sandbox corpus
  const gateDir = join(SANDBOX, "gates");
  mkdirSync(gateDir, { recursive: true });
  const c2 = compilerMod.compile({ name: "T", traits: ["loves dirty talk", "diagnosed with hypertension", "money: rainy day fund"], hardLines: [], voiceNotes: "" });
  writeFileSync(join(gateDir, "persona-claude.md"), c2.markdown);
  for (const [id, d] of Object.entries(c2.sealedDocs)) writeFileSync(join(gateDir, `persona-claude-${id}.md`), d.markdown);
  const cube = makeCubeRecall({ boundary: makeRecallBoundary(), floor: 0.04, weights: { semantic: 0.82, provenance: 0.06, time: 0.12 } });
  cube.load(recall.loadPoints(gateDir));
  const q = (allow) => cube.query({ center: "sealed persona profile scope", k: 10, ctx: { personal: true, allowScopes: allow } });
  const none = (await q([])).filter((h) => h.id !== "persona-claude");
  const med = (await q(["sealed-medical"])).map((h) => h.id);
  const two = (await q(["sealed-intimate", "sealed-finances"])).map((h) => h.id);
  check("scope gate: no grant admits nothing sealed", none.length === 0, none.map((h) => h.id).join(","));
  check("scope gate: single grant admits only its compartment",
    med.includes("persona-claude-medical") && !med.includes("persona-claude-intimate") && !med.includes("persona-claude-finances"));
  check("scope gate: grants compose additively",
    two.includes("persona-claude-intimate") && two.includes("persona-claude-finances") && !two.includes("persona-claude-medical"));
} catch (e) { check("routing/compile/gates", false, e.message); }

// 7 — temperament inert at neutral
try {
  const p = temperament.projectDials({});
  check("temperament: inert at neutral", p.tone === "" && p.prosody.rate === 1 && p.toneHints.length === 0);
} catch (e) { check("temperament inert", false, e.message); }

rmSync(SANDBOX, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
