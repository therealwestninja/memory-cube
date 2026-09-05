// selftest.mjs — one-command health check for the whole drop-in. Run BEFORE and AFTER a Claude Code update:
//   node selftest.mjs
// Exits 0 with "ALL PASS" or 1 listing every failed assertion. Touches NOTHING real except a reversible
// tombstone round-trip on state/boundary.json (restored before exit); scope-gate tests run in a temp sandbox dir.

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

// 1 — engine modules load and expose their APIs
let makeCubeRecall, makeRecallBoundary, temperament, LexCore;
try {
  ({ makeCubeRecall } = await import("./engine/cubeRecall.js"));
  ({ makeRecallBoundary } = await import("./engine/recallBoundary.js"));
  temperament = await import("./engine/temperament.js");
  const { createRequire } = await import("node:module");
  LexCore = createRequire(import.meta.url)("./engine/lexcore.cjs");
  check("engine modules load", !!(makeCubeRecall && makeRecallBoundary && temperament.projectDials && LexCore.make));
} catch (e) { check("engine modules load", false, e.message); }

// 2 — real corpus loads; installed persona + index line present
let recall, points = [];
try {
  recall = await import("./recall.mjs");
  points = recall.loadPoints();
  check("memory corpus loads (>=200 points)", points.length >= 200, `got ${points.length}`);
  check("persona-claude.md installed", points.some((p) => p.id === "persona-claude"));
  const idx = readFileSync(join(recall.MEMORY_DIR, "MEMORY.md"), "utf8");
  check("MEMORY.md index line present", /\[Persona \(user-tuned\)\]/.test(idx));
  check("no sealed file leaked into MEMORY.md", !/persona-claude-(intimate|medical|finances|vent)/.test(idx));
} catch (e) { check("memory corpus loads (>=200 points)", false, e.message); }

// 3 — recall ranking sanity on known queries
try {
  const q1 = await recall.runQuery("safeword safety stop", { k: 3 });
  check("recall: safeword query hits safeword-single-path", q1.some((h) => h.id === "safeword-single-path"),
    q1.map((h) => h.id).join(","));
  const q2 = await recall.runQuery("FY500 stroker brain integration", { k: 3 });
  check("recall: fy500 query top hit", q2[0] && q2[0].id === "fy500-integration", q2[0] && q2[0].id);
} catch (e) { check("recall ranking", false, e.message); }

// 4 — tombstone round-trip on the REAL boundary state (fully reversed)
try {
  const target = "fy500-integration";
  let eng = recall.makeEngine();
  const before = eng.boundary.isTombstoned(target);
  eng.boundary.tombstone(target); eng.saveBoundary();
  const gone = !(await recall.runQuery("FY500 stroker brain integration", { k: 5 })).some((h) => h.id === target);
  eng = recall.makeEngine();               // fresh engine proves persistence
  const persisted = eng.boundary.isTombstoned(target);
  eng.boundary.untombstone(target); eng.saveBoundary();
  const back = (await recall.runQuery("FY500 stroker brain integration", { k: 5 })).some((h) => h.id === target);
  check("tombstone: unreachable while set, persisted, reversible", !before && gone && persisted && back);
} catch (e) { check("tombstone round-trip", false, e.message); }

// 5 — compartment routing matrix (the regression set)
try {
  const { makeRouter } = await import("./compartments.mjs");
  const r = makeRouter();
  const cases = [
    ["loves dirty talk", "intimate", false],
    ["edge me and deny it", "intimate", false],                    // stock category allowlist
    ["terse replies please", null, false],                          // the affirm_yes("please") regression
    ["diagnosed with hypertension last spring", "medical", false],
    ["vent: importer wasted my evening", "vent", false],            // prefix rule type
    ["budget tracking helps me focus", "finances", true],           // ambiguous -> ask
    ["be explicit about errors", "intimate", true],                 // ambiguous -> ask
    ["prefers naming the uncomfortable finding first", null, false] // L0 stock must NOT route
  ];
  let ok = true, why = "";
  for (const [text, route, ask] of cases) {
    const a = r.analyze(text);
    if (a.route !== route || a.ask !== ask) { ok = false; why += `[${text} -> ${a.route}/${a.ask} wanted ${route}/${ask}] `; }
  }
  check("routing matrix (8 cases)", ok, why);
  const routed = r.routeItems(["be explicit about errors"], { "be explicit about errors": "public" });
  check("routing: stored override wins", routed.pub.length === 1 && !routed.pending.length);
} catch (e) { check("routing matrix", false, e.message); }

// 6 — compile: public file carries no sealed text; per-compartment docs + counts coherent
let compilerMod;
try {
  compilerMod = await import("./compile-persona.mjs");
  const c = compilerMod.compile({ name: "T", traits: ["loves dirty talk", "diagnosed with hypertension", "terse replies please"], hardLines: ["no degradation play"], voiceNotes: "" });
  const okSplit = !c.markdown.includes("dirty talk") && !c.markdown.includes("hypertension") &&
    c.markdown.includes("terse replies please") &&
    c.sealedDocs.intimate && c.sealedDocs.intimate.markdown.includes("dirty talk") &&
    c.sealedDocs.medical && c.sealedDocs.medical.markdown.includes("hypertension");
  check("compile: sealed text absent from public file", okSplit);
  check("compile: counts coherent", c.sealedCount === Object.values(c.counts).reduce((a, b) => a + b, 0) && c.counts.intimate === 2 && c.counts.medical === 1);
  check("compile: sealed docs carry scope frontmatter", /scope: sealed-intimate/.test(c.sealedDocs.intimate.markdown));
} catch (e) { check("compile split", false, e.message); }

// 7 — scope gates end-to-end in a sandbox corpus (env-pointed, real dir untouched)
try {
  const sandbox = join(tmpdir(), "claude-persona-selftest");
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const c = compilerMod.compile({ name: "T", traits: ["loves dirty talk", "diagnosed with hypertension", "money: rainy day fund"], hardLines: [], voiceNotes: "" });
  writeFileSync(join(sandbox, "persona-claude.md"), c.markdown);
  for (const [id, d] of Object.entries(c.sealedDocs)) writeFileSync(join(sandbox, `persona-claude-${id}.md`), d.markdown);
  const boundary = makeRecallBoundary();                      // fresh, no persisted state
  const cube = makeCubeRecall({ boundary, floor: 0.04, weights: { semantic: 0.82, provenance: 0.06, time: 0.12 } });
  cube.load(recall.loadPoints(sandbox));
  const q = (allow) => cube.query({ center: "sealed persona profile scope", k: 10, ctx: { personal: true, allowScopes: allow } });
  const none = (await q([])).filter((h) => h.id !== "persona-claude");
  const med = (await q(["sealed-medical"])).map((h) => h.id);
  const two = (await q(["sealed-intimate", "sealed-finances"])).map((h) => h.id);
  check("scope gate: no grant admits nothing sealed", none.length === 0, none.map((h) => h.id).join(","));
  check("scope gate: medical grant admits only medical",
    med.includes("persona-claude-medical") && !med.includes("persona-claude-intimate") && !med.includes("persona-claude-finances"));
  check("scope gate: grants compose additively",
    two.includes("persona-claude-intimate") && two.includes("persona-claude-finances") && !two.includes("persona-claude-medical"));
  rmSync(sandbox, { recursive: true, force: true });
} catch (e) { check("scope gates", false, e.message); }

// 8 — temperament projection still inert at neutral (Rook invariant)
try {
  const p = temperament.projectDials({});
  check("temperament: inert at neutral", p.tone === "" && p.prosody.rate === 1 && p.toneHints.length === 0);
} catch (e) { check("temperament inert", false, e.message); }

console.log(results.join("\n"));
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
