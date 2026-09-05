// recall.mjs — hypercube recall over the Claude Code memory directory. A DROP-IN: reads the same one-fact-per-file
// markdown corpus Claude already uses; nothing here rewrites a memory. Reuses Rook's engine verbatim (engine/cubeRecall.js
// + engine/recallBoundary.js): boundary-first filtering (tombstones / forget-floor / valid-time) BEFORE any relevance
// scoring, then the 3-axis composed score (semantic IDF-cosine + provenance + valid-time freshness).
//
// Point mapping (memory file -> hypercube point):
//   id         <- frontmatter name (slug)
//   text       <- description + body (what the IDF scorer sees)
//   ts         <- metadata.modified || file mtime (when the memory was formed)
//   validFrom  <- metadata.validFrom || ts     validTo <- metadata.validTo || null (still current)
//   provenance <- metadata.source || "firsthand" (unstamped legacy memories default to firsthand — they record work done)
//   scope      <- "public" (Claude's memory dir has one compartment today)
//
// Boundary state (tombstones = "forget X and keep it forgotten") persists in state/boundary.json — a forget survives
// restarts and cannot be out-scored by a high similarity, which plain index recall cannot promise.
//
// CLI:
//   node recall.mjs query "<text>" [--as-of 2026-07-01] [--k 5] [--provenance firsthand|told|inferred] [--explain]
//   node recall.mjs forget <id>        node recall.mjs unforget <id>        node recall.mjs forgotten

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecallBoundary } from "./engine/recallBoundary.js";
import { makeCubeRecall } from "./engine/cubeRecall.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEMORY_DIR = process.env.CLAUDE_MEMORY_DIR ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", "D--Claude", "memory");
const BOUNDARY_FILE = join(HERE, "state", "boundary.json");

// ── memory file -> point ─────────────────────────────────────────────────────
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}
const toMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

export function loadPoints(dir = MEMORY_DIR) {
  const points = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    let raw; try { raw = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const mtime = statSync(join(dir, f)).mtimeMs;
    const ts = toMs(meta.modified) ?? mtime;
    points.push({
      id: meta.name || f.replace(/\.md$/, ""),
      file: f,
      description: meta.description || "",
      type: meta.type || "project",
      // scoring surface: slug words + the curated description ONLY. Long jargon-dense bodies inflate the IDF-cosine
      // doc norm unevenly and bury exact matches (fy500-integration lost its own query to a longer neighbor); the
      // description is the write-time-curated recall key, which is exactly what this corpus's design intends.
      text: (meta.name || f).replace(/-/g, " ") + " " + (meta.description || "") ,
      body: body.slice(0, 400),
      ts,
      validFrom: toMs(meta.validFrom) ?? ts,
      validTo: toMs(meta.validTo) ?? null,
      provenance: meta.source || "firsthand",
      // scope from frontmatter (e.g. sealed-intimate on the routed persona file). recallBoundary treats a non-public
      // scope as a HARD predicate: unreachable unless the query carries an explicit allowScopes grant (R1).
      scope: meta.scope || "public",
    });
  }
  return points;
}

// ── engine with persisted boundary ───────────────────────────────────────────
export function makeEngine({ dir = MEMORY_DIR } = {}) {
  let bState = null;
  try { if (existsSync(BOUNDARY_FILE)) bState = JSON.parse(readFileSync(BOUNDARY_FILE, "utf8")); } catch {}
  const boundary = makeRecallBoundary({ state: bState });
  // floor lowered from the engine's 0.15 default: absolute IDF-cosine runs small over this corpus' long documents,
  // but the RANKING stays correct — 0.04 keeps the drop-nearest-noise property without discarding every real hit.
  // floor + weights retuned for THIS corpus vs the engine defaults: absolute IDF-cosine runs small over long documents
  // (ranking stays correct), and provenance is near-uniform (legacy memories all default firsthand) so at 0.25 it adds a
  // constant that lets the time axis outvote a real semantic match. Heavy semantic until the corpus is facet-backfilled.
  const cube = makeCubeRecall({ boundary, floor: 0.04, weights: { semantic: 0.82, provenance: 0.06, time: 0.12 } });
  const points = loadPoints(dir);
  cube.load(points);
  const saveBoundary = () => writeFileSync(BOUNDARY_FILE, JSON.stringify(boundary.serialize(), null, 2));
  return { boundary, cube, points, saveBoundary };
}

export async function runQuery(text, { asOf = null, k = 5, provenance = null, personal = true, allowScopes = [] } = {}) {
  const { cube } = makeEngine();
  const offsets = {};
  if (asOf != null) offsets.asOf = asOf;
  if (provenance) offsets.provenance = provenance;
  const hits = await cube.query({ center: text, offsets, k, ctx: { personal, allowScopes } });
  return hits.map((h) => ({ ...h, _explain: cube.explain(h) }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "\\");
if (isMain || process.argv[1]?.endsWith("recall.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : null; };
  const has = (name) => rest.includes("--" + name);

  if (cmd === "query") {
    const VALUED = new Set(["--as-of", "--k", "--provenance", "--scope"]);
    const textParts = [];
    for (let i = 0; i < rest.length; i++) {
      if (VALUED.has(rest[i])) { i++; continue; }
      if (rest[i].startsWith("--")) continue;
      textParts.push(rest[i]);
    }
    const text = textParts.join(" ");
    const asOfStr = flag("as-of");
    const asOf = asOfStr ? Date.parse(asOfStr) : null;
    // --scope takes compartment ids or raw scope names, comma-separated ("intimate,finances")
    const { scopeFor } = await import("./compartments.mjs");
    const allowScopes = String(flag("scope") || "").split(",").map((s) => scopeFor(s)).filter(Boolean);
    const hits = await runQuery(text, { asOf, k: Number(flag("k")) || 5, provenance: flag("provenance"), allowScopes });
    if (!hits.length) console.log("(nothing relevant — semantic floor or boundary removed everything)");
    for (const h of hits) {
      const when = new Date(h.validFrom).toISOString().slice(0, 10);
      console.log(`${h._score.toFixed(3)}  ${h.id}  [${h.provenance}, ${when}]  ${h.description.slice(0, 100)}`);
      if (has("explain")) {
        const e = h._explain;
        console.log(`       axes: semantic ${e.semantic} + provenance ${e.provenance} + time ${e.time} = ${e.total}`);
      }
    }
  } else if (cmd === "forget" || cmd === "unforget") {
    const { boundary, saveBoundary } = makeEngine();
    const id = rest[0];
    if (cmd === "forget") boundary.tombstone(id); else boundary.untombstone(id);
    saveBoundary();
    console.log(`${cmd === "forget" ? "tombstoned" : "restored"}: ${id} (persisted; ${boundary.tombstoneCount()} total)`);
  } else if (cmd === "forgotten") {
    const { boundary } = makeEngine();
    console.log(JSON.stringify(boundary.serialize(), null, 2));
  } else {
    console.log("usage: recall.mjs query \"text\" [--as-of DATE] [--k N] [--provenance P] [--explain] | forget <id> | unforget <id> | forgotten");
  }
}
