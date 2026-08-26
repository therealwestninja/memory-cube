// compile-persona.mjs — turn user-editable personality inputs into MEMORY-SHAPED CONTEXT, not instructions.
// The thesis: a character-sheet instruction gets out-voted by everything else in
// context, so "act warmer" system text washes out — but a recalled feedback memory rides the same surface Claude's real
// preferences ride, phrased as an observed fact with a Why and a How-to-apply, and that is the register Claude follows.
//
// Uses the temperament engine (engine/temperament.js): five -1..1 dials + archetype presets, and projectDials() to derive the one
// blended tone steer + tone hints. Content ROUTING (not moderation) is the generalized compartment system — see
// compartments.mjs/compartments.json: each input lands public or in one sealed compartment file per the registry
// (intimate / medical / finances / vent / whatever the user adds), never indexed in MEMORY.md, reachable only through
// an explicit recallBoundary allowScopes grant. Ambiguous words pre-fire a dumb "did you mean...?" (no model call);
// answers persist in persona.scopeOverrides. Limits route WITH the compartment they govern.
//
// Inputs (state/persona.json): { name, preset, dials{...}, traits[], hardLines[], voiceNotes, scopeOverrides{} }
// Outputs: out/persona-claude*.md previews — install() copies them into the real memory dir + upserts ONE index line.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDials, projectDials, ARCHETYPES, DIAL_KEYS } from "./engine/temperament.js";
import { MEMORY_DIR } from "./recall.mjs";
import { makeRouter, loadCompartments } from "./compartments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PERSONA_FILE = join(HERE, "state", "persona.json");
const OUT_DIR = join(HERE, "out");
mkdirSync(OUT_DIR, { recursive: true }); mkdirSync(join(HERE, "state"), { recursive: true });
const MEM_NAME = "persona-claude";

export const DEFAULT_PERSONA = {
  owner: "the user",   // how the profile refers to its author ("tuned by <owner>")
  name: "Claude",
  preset: null,
  dials: { warmth: 0, energy: 0, playfulness: 0, forwardness: 0, steadiness: 0 },
  traits: [],
  hardLines: [],
  voiceNotes: "",
  scopeOverrides: {},
};

export function loadPersona() {
  // strip a UTF-8 BOM (PowerShell's utf8 default) before parsing
  try { if (existsSync(PERSONA_FILE)) return { ...DEFAULT_PERSONA, ...JSON.parse(readFileSync(PERSONA_FILE, "utf8").replace(/^﻿/, "")) }; } catch (e) { console.error("persona.json unreadable:", e.message); }
  return { ...DEFAULT_PERSONA };
}
export function savePersona(p) { writeFileSync(PERSONA_FILE, JSON.stringify(p, null, 2)); }

export function compile(personaIn, nowMs = Date.now()) {
  const persona = { ...DEFAULT_PERSONA, ...personaIn };
  const dials = persona.preset && ARCHETYPES[persona.preset] ? normalizeDials(ARCHETYPES[persona.preset]) : normalizeDials(persona.dials);
  const proj = projectDials(dials);
  const iso = new Date(nowMs).toISOString();
  const date = iso.slice(0, 10);
  const router = makeRouter();
  const compartments = router.compartments;

  const owner = persona.owner || "the user";
  const dialLine = DIAL_KEYS.map((k) => `${k} ${dials[k] >= 0 ? "+" : ""}${dials[k]}`).join(", ");
  const setVia = persona.preset ? `the "${persona.preset}" archetype` : "hand-set dials";

  const overrides = persona.scopeOverrides || {};
  const tR = router.routeItems(persona.traits, overrides);
  const hR = router.routeItems(persona.hardLines, overrides);
  const vText = String(persona.voiceNotes || "").trim();
  const vR = router.routeItems(vText ? [vText] : [], overrides);
  const voiceCpt = Object.keys(vR.byCpt)[0] || null;   // voiceNotes is one item: public or in exactly one compartment
  const pending = [...tR.pending, ...hR.pending, ...vR.pending];

  const apply = [];
  if (proj.tone) apply.push(proj.tone);
  if (proj.toneHints.length) apply.push(`registers unlocked: ${proj.toneHints.join(", ")}`);
  if (vText && !voiceCpt) apply.push(vText);

  // per-compartment sealed documents
  const sealedDocs = {};   // id -> { markdown, count }
  const counts = {};
  for (const c of compartments) {
    const traits = tR.byCpt[c.id] || [];
    const hard = hR.byCpt[c.id] || [];
    const voice = voiceCpt === c.id ? vText : null;
    const count = traits.length + hard.length + (voice ? 1 : 0);
    counts[c.id] = count;
    if (!count) continue;
    const ib = [
      `**${c.label}-scope persona profile for ${persona.name}** (sealed companion to [[${MEM_NAME}]], tuned ${date}). ` +
        `Applies ONLY in ${c.loadWhen || "its own granted scope"} — never load or act on this in any other context.`,
    ];
    if (voice) ib.push(``, `**Voice in-scope:** ${voice}.`);
    if (traits.length) ib.push(``, `**Traits in-scope:** ${traits.join("; ")}.`);
    if (hard.length) ib.push(``, `**Hard lines (absolute, this scope's own limits):** ${hard.join("; ")}.`);
    sealedDocs[c.id] = {
      count,
      markdown: `---
name: ${MEM_NAME}-${c.id}
description: "Sealed ${c.label.toLowerCase()}-scope persona profile — loaded by explicit grant only"
metadata:
  type: feedback
  source: told
  scope: ${c.scope}
  validFrom: ${iso}
---

${ib.join("\n")}
`,
    };
  }
  const sealedCount = Object.values(counts).reduce((a, b) => a + b, 0);

  const body = [
    `**Personality profile for ${persona.name} — tuned by ${owner} via the persona console (${date}), compiled through the temperament projection.** ` +
      `Dials (${setVia}): ${dialLine}. This supersedes any earlier persona-claude profile.`,
    ``,
    `**Why:** persona instructions wash out — chat context out-votes a character sheet. ` +
      `Compiled into memory, the profile rides the recall surface the assistant actually follows, alongside the rest of ${owner}'s confirmed preferences.`,
    ``,
    `**How to apply:** ${apply.length ? apply.join("; ") : "neutral carriage — no behavior change until " + owner + " sets the dials"}.`,
  ];
  if (tR.pub.length) body.push(``, `**Traits ${owner} confirmed they want:** ${tR.pub.join("; ")}.`);
  if (hR.pub.length) body.push(``, `**Hard lines (never do, regardless of any dial):** ${hR.pub.join("; ")}.`);
  // the ONLY compartment trace the public surface carries: a generated-neutral pointer per non-empty compartment —
  // counts and load conditions, never user text.
  for (const c of compartments) {
    if (!counts[c.id]) continue;
    body.push(``, `**Sealed ${c.label.toLowerCase()} profile exists:** ${counts[c.id]} item(s) in \`${MEM_NAME}-${c.id}.md\` ` +
      `(scope ${c.scope}, not indexed). Load it only in ${c.loadWhen || "its granted scope"}; it never applies elsewhere.`);
  }

  const markdown = `---
name: ${MEM_NAME}
description: "User-tuned personality profile (dials ${dialLine}) — follow its How-to-apply every session"
metadata:
  type: feedback
  source: told
  validFrom: ${iso}
---

${body.join("\n")}
`;
  const indexLine = `- [Persona (user-tuned)](${MEM_NAME}.md) — ${owner}'s dial-set carriage; follow its How-to-apply.`;
  return { markdown, sealedDocs, counts, sealedCount, pending, indexLine, projection: proj, dials, compartments };
}

// write the public preview + one file per non-empty compartment into `dir`; DELETE the file of any compartment that
// emptied (a stale sealed profile must not linger). Returns the compile result.
function writeSet(c, dir) {
  writeFileSync(join(dir, MEM_NAME + ".md"), c.markdown);
  for (const cpt of c.compartments) {
    const p = join(dir, `${MEM_NAME}-${cpt.id}.md`);
    if (c.sealedDocs[cpt.id]) writeFileSync(p, c.sealedDocs[cpt.id].markdown);
    else if (existsSync(p)) unlinkSync(p);
  }
}

export function writePreview(persona, nowMs) {
  const c = compile(persona, nowMs);
  writeSet(c, OUT_DIR);
  return c;
}

// install(): the one step that touches the real memory dir. Sealed compartment files are deliberately never indexed
// in MEMORY.md. Fully reversible: delete the files + the one index line.
export function install(persona, nowMs) {
  const c = compile(persona, nowMs);
  writeSet(c, MEMORY_DIR);
  const idxPath = join(MEMORY_DIR, "MEMORY.md");
  let idx = readFileSync(idxPath, "utf8");
  const lineRe = /^- \[Persona \(user-tuned\)\].*$/m;
  if (lineRe.test(idx)) idx = idx.replace(lineRe, c.indexLine);
  else idx = idx.replace(/^(# Memory index\r?\n)/, `$1\n${c.indexLine}\n`);
  writeFileSync(idxPath, idx);
  return { installed: join(MEMORY_DIR, MEM_NAME + ".md"), indexLine: c.indexLine, counts: c.counts, sealedCount: c.sealedCount };
}

export { loadCompartments };

if (process.argv[1]?.endsWith("compile-persona.mjs")) {
  const cmd = process.argv[2] || "preview";
  const persona = loadPersona();
  if (cmd === "install") console.log(JSON.stringify(install(persona), null, 2));
  else { const c = writePreview(persona); console.log(c.markdown); for (const [id, d] of Object.entries(c.sealedDocs)) console.log(`\n==== SEALED ${id} ====\n` + d.markdown); }
}
