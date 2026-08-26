// serve.mjs — no-dependency local server for the persona console. 127.0.0.1 only.
//   GET  /               console.html
//   GET  /api/state      { persona, archetypes, projection, memoryDir, points, forgotten }
//   POST /api/persona    save persona.json + write out/ preview            -> { markdown, projection }
//   POST /api/install    write persona-claude.md into the REAL memory dir  -> { installed, indexLine }
//   POST /api/query      { text, asOf?, k? } -> hypercube hits with per-axis explain
//   POST /api/forget     { id }   POST /api/unforget { id }   (persisted tombstones)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./engine/temperament.js";
import { loadPersona, savePersona, writePreview, install, compile } from "./compile-persona.mjs";
import { loadCompartments, scopeFor } from "./compartments.mjs";
import { makeEngine, runQuery, MEMORY_DIR } from "./recall.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PERSONA_PORT) || 48972;

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/console.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(HERE, "console.html")));
    }
    if (req.method === "GET" && req.url === "/api/state") {
      const persona = loadPersona();
      const { boundary, points } = makeEngine();
      return json(res, 200, {
        persona, archetypes: ARCHETYPES, projection: compile(persona).projection,
        compartments: loadCompartments().map(({ id, label, scope, loadWhen }) => ({ id, label, scope, loadWhen })),
        memoryDir: MEMORY_DIR, points: points.length, forgotten: boundary.serialize().tombstones,
      });
    }
    if (req.method === "POST" && req.url === "/api/persona") {
      const { persona } = await body(req);
      savePersona(persona);
      const c = writePreview(persona);
      return json(res, 200, { markdown: c.markdown, sealedDocs: Object.fromEntries(Object.entries(c.sealedDocs).map(([id, d]) => [id, d.markdown])),
        counts: c.counts, sealedCount: c.sealedCount, pending: c.pending, projection: c.projection, dials: c.dials });
    }
    if (req.method === "POST" && req.url === "/api/install") {
      return json(res, 200, install(loadPersona()));
    }
    if (req.method === "POST" && req.url === "/api/query") {
      const { text, asOf, k, grantScopes } = await body(req);
      const allowScopes = (Array.isArray(grantScopes) ? grantScopes : []).map((s) => scopeFor(s)).filter(Boolean);
      const hits = await runQuery(String(text || ""), { asOf: asOf ? Date.parse(asOf) : null, k: Number(k) || 6, allowScopes });
      return json(res, 200, { hits: hits.map((h) => ({ id: h.id, file: h.file, description: h.description, provenance: h.provenance, validFrom: h.validFrom, score: h._score, axes: h._axes, explain: h._explain })) });
    }
    if (req.method === "POST" && (req.url === "/api/forget" || req.url === "/api/unforget")) {
      const { id } = await body(req);
      const { boundary, saveBoundary } = makeEngine();
      if (req.url === "/api/forget") boundary.tombstone(id); else boundary.untombstone(id);
      saveBoundary();
      return json(res, 200, { forgotten: boundary.serialize().tombstones });
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`persona console on http://127.0.0.1:${PORT}`));
