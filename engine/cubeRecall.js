// cubeRecall.js — Tier-2 of the memory-hypercube (docs/MEMORY-HYPERCUBE.md §5, restricted to §12's build stance). A THIN
// composed-space recall over an EXISTING sparse point-set. It MATERIALISES NOTHING (no kⁿ grid — it stores the points/refs
// you load and composes existing signals at query time), and it ships with explain() from commit one because inspectability
// is a Rook north-star (§8 contestability: "why did you say that?" answered with per-axis coordinates).
//
// THREE axes only — the exact/safe structured ones (§12 Tier-2): semantic + provenance + valid-time. Person/affect axes are
// deliberately NOT here: they are the learned-embedding offsets that turn memory into R1/R3's triangulation surface, gated
// behind a future bench pass. Offsets are STRUCTURED only: offsets.asOf (the valid-time view — "what did I believe last
// week") and offsets.provenance (prefer a provenance). No word2vec vector arithmetic.
//
// §7 BOUNDARY GUARANTEE (non-negotiable, enforced structurally): every query runs boundary.filter() FIRST — the Tier-1
// recallBoundary point-set pre-filter removes out-of-bounds points (tombstone/forget-floor/scope/valid-time) BEFORE any
// distance is computed. Only survivors are scored. So an offset can bias DIRECTION (which provenance/time we prefer) but can
// NEVER grant reach past a boundary (R1), and a tombstoned point is unreachable from EVERY asOf (R2). A high similarity can
// never overwhelm a boundary because the boundary is a hard predicate applied to the point-set, not a soft weight in the sum.
//
// SEMANTIC axis: an injected embed(text)->vector gives cosine similarity; ABSENT, we fall back to an IDF-WEIGHTED-COSINE
// keyword scorer built over the loaded point-set — NOT raw keyword. The cube-bench FINDING was that a raw-keyword floor
// admits a spurious single shared word ("favorite dinosaur" → "favorite coffee", 0.5 raw). IDF down-weights common words, and
// the unmatched DISTINCTIVE word (rare → high idf) inflates the query norm, so a lone common-word match scores near zero (§6).
//
// PURE: no clock/random/network/IO inside. asOf (the valid-time view) is passed per query, never read from a clock.
// serialize()/restore() carries config + IDF stats; the caller re-load()s the points. House style mirrors memoryRank.js.

const STOP = new Set(("a an the i you your my me of is are was were do did to in on at for it s t as now then " +
  "what where who when why how and or but not with about this that these those be been being have has had").split(" "));
const words = (s) => (String(s == null ? "" : s).toLowerCase().match(/[a-z0-9]+/g) || []);
const contentWords = (s) => [...new Set(words(s).filter((w) => !STOP.has(w) && w.length > 1))];

export function makeCubeRecall({
  boundary = null,
  embed = null,
  // Axis weights are NOT hand-waved — they encode a policy (how far firsthand-ness / freshness may override a better keyword
  // match) that is validated + regression-guarded by bench/recall-weights-bench.mjs. That bench grid-searches the simplex over
  // labeled conflict cases; this default sits centrally in the feasible region (feasible: semantic 0.55–0.75, provenance
  // 0.15–0.35, time 0.05–0.15). Change scoring → re-run the bench; if the default leaves the region, the bench fails.
  weights = { semantic: 0.6, provenance: 0.25, time: 0.15 },
  floor = 0.15,
  idf = true,
} = {}) {
  // lazily import-free: if no boundary injected, the caller can pass one; otherwise we expect makeRecallBoundary to be
  // supplied. We construct a minimal internal one only if a factory is reachable — but to keep imports to recallBoundary.js
  // only, we require the caller to inject it OR we build via the imported factory below.
  const _boundary = boundary || _makeInternalBoundary();
  const W = { semantic: 0.6, provenance: 0.25, time: 0.15, ...weights };

  let points = [];                 // sparse point-set (refs; nothing materialised)
  let byId = new Map();
  let df = new Map();              // document-frequency per content word (for IDF)
  let N = 0;                       // number of docs indexed

  function _reindex() {
    byId = new Map(points.map((p) => [String(p.id), p]));
    df = new Map();
    N = points.length;
    for (const p of points) {
      for (const w of contentWords(p.text)) df.set(w, (df.get(w) || 0) + 1);
    }
  }
  const idfOf = (w) => Math.max(0.01, Math.log((N + 1) / ((df.get(w) || 0) + 1)));

  function load(pts) { points = Array.isArray(pts) ? pts.slice() : []; _reindex(); return points.length; }
  function add(p) { if (p && p.id != null) { points.push(p); _reindex(); } return points.length; }

  // ── SEMANTIC axis ──────────────────────────────────────────────────────────
  // idf-weighted cosine over content-word sets: the unmatched distinctive (rare, high-idf) query word inflates the query
  // norm, so a lone common-word ("favorite") overlap scores near zero — the bench's keyword-floor finding, fixed.
  function idfCosine(qWords, dWords) {
    if (!qWords.length || !dWords.length) return 0;
    const dSet = new Set(dWords);
    let dot = 0, nq = 0, nd = 0;
    for (const w of qWords) { const v = idfOf(w); nq += v * v; if (dSet.has(w)) dot += v * v; }
    for (const w of dWords) { const v = idfOf(w); nd += v * v; }
    return (nq && nd) ? dot / (Math.sqrt(nq) * Math.sqrt(nd)) : 0;
  }
  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    let dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  async function semanticSim(centerText, p, embQueryVec) {
    if (embed) {
      // PREFER a precomputed point.embedding (a minted-pack vector) — the whole power-up: the device skips on-device
      // embedding for items that already carry a vector in the SAME model space. Additive + backward-compatible: a point
      // without `.embedding` re-embeds from `.text` exactly as before. (Model-compat is enforced upstream at ingest — a
      // wrong-space vector is never attached; see knowledgeMint.toPoints / §3.)
      const pv = (Array.isArray(p.embedding) && p.embedding.length) ? p.embedding : await embed(p.text);
      return Math.max(0, cosine(embQueryVec, pv));
    }
    // idf fallback (idf flag lets the caller force plain overlap for debugging; default idf-weighted)
    if (idf) return idfCosine(contentWords(centerText), contentWords(p.text));
    const qs = contentWords(centerText), ts = new Set(words(p.text));
    return qs.length ? qs.filter((w) => ts.has(w)).length / qs.length : 0;
  }

  // ── PROVENANCE axis ────────────────────────────────────────────────────────
  // an offset.provenance sets an explicit preferred provenance; else a personal query prefers the user's own memory and
  // penalises "web" (R5: a web fact must never masquerade as first-hand); a non-personal (world-fact) query is neutral.
  function provScore(p, target, personal) {
    const prov = p.provenance || "none";
    if (target) return prov === target ? 1 : 0.4;
    if (personal) {
      if (prov === "user" || prov === "firsthand") return 1;
      if (prov === "web") return 0.25;   // penalty — never let a web fact win a personal query on a keyword tie
      return 0.6;
    }
    return 0.7;   // world-fact query: web is fine
  }

  // ── VALID-TIME axis ────────────────────────────────────────────────────────
  // survivors are already valid at asOf (the boundary filtered them); this axis just prefers the FRESHER fact — the one that
  // started most recently before the as-of view. Min-max normalised across survivors so scale never dominates.
  function timeRaw(p, ref) {
    const start = Number.isFinite(+p.validFrom) ? +p.validFrom : (Number.isFinite(+p.ts) ? +p.ts : 0);
    if (ref != null && start > ref) return -Infinity;   // future w.r.t the view (shouldn't survive the filter)
    return start;
  }
  function normTime(raws) {
    const finite = raws.filter((x) => Number.isFinite(x));
    if (!finite.length) return raws.map(() => 0);
    const lo = Math.min(...finite), hi = Math.max(...finite);
    if (hi === lo) return raws.map((x) => (Number.isFinite(x) ? 0.5 : 0));
    return raws.map((x) => (Number.isFinite(x) ? (x - lo) / (hi - lo) : 0));
  }

  // map structured offsets + ctx → the boundary's query context (an offset never reaches past a boundary — §7).
  function ctxFor(offsets = {}, ctx = {}) {
    return {
      scope: ctx.scope || "public",
      allowScopes: Array.isArray(ctx.allowScopes) ? ctx.allowScopes : [],
      asOf: (offsets.asOf != null) ? offsets.asOf : (ctx.asOf != null ? ctx.asOf : null),
    };
  }

  async function query({ center, offsets = {}, weights: qw, k = 5, ctx = {} } = {}) {
    const w = qw ? { ...W, ...qw } : W;
    const centerText = (center && typeof center === "object") ? (center.text || "") : (center || "");
    const bctx = ctxFor(offsets, ctx);

    // STEP 1 — boundary pre-filter FIRST (R1/R2). Only survivors are ever scored.
    const { kept } = _boundary.filter(points, bctx);
    if (!kept.length) return [];

    // STEP 2 — per-axis similarities on survivors.
    const embQueryVec = embed ? await embed(centerText) : null;
    const target = offsets.provenance || null;
    const personal = !!ctx.personal;
    const ref = bctx.asOf;

    const rawTimes = kept.map((p) => timeRaw(p, ref));
    const nTime = normTime(rawTimes);

    const scored = [];
    for (let i = 0; i < kept.length; i++) {
      const p = kept[i];
      const semantic = await semanticSim(centerText, p, embQueryVec);
      const provenance = provScore(p, target, personal);
      const time = nTime[i];
      const _score = +(w.semantic * semantic + w.provenance * provenance + w.time * time).toFixed(6);
      scored.push({ ...p, _score, _axes: { semantic: +semantic.toFixed(6), provenance: +provenance.toFixed(6), time: +time.toFixed(6) }, _w: { ...w } });
    }

    // STEP 3 — distance floor on the SEMANTIC axis: drop confident-nearest-noise; empty region → "nothing relevant".
    const relevant = scored.filter((h) => h._axes.semantic >= floor);
    if (!relevant.length) return [];

    // STEP 4 — top-k.
    relevant.sort((a, b) => b._score - a._score);
    return relevant.slice(0, k);
  }

  // explain(hit) — per-axis CONTRIBUTION (weight × axis similarity); the three sum to _score (inspectability, §8).
  function explain(hit) {
    if (!hit || !hit._axes) return { semantic: 0, provenance: 0, time: 0, total: 0 };
    const w = hit._w || W;
    const semantic = +(w.semantic * hit._axes.semantic).toFixed(6);
    const provenance = +(w.provenance * hit._axes.provenance).toFixed(6);
    const time = +(w.time * hit._axes.time).toFixed(6);
    return { semantic, provenance, time, total: +(semantic + provenance + time).toFixed(6) };
  }

  function serialize() {
    return { config: { weights: W, floor, idf, hasEmbed: !!embed }, idfStats: { N, df: Object.fromEntries(df) } };
  }
  function restore(s) {
    if (!s || typeof s !== "object") return;
    if (s.config) { if (s.config.weights) Object.assign(W, s.config.weights); if (typeof s.config.floor === "number") floor = s.config.floor; }
    if (s.idfStats) { N = Number(s.idfStats.N) || 0; df = new Map(Object.entries(s.idfStats.df || {}).map(([k, v]) => [k, Number(v) || 0])); }
  }

  return {
    boundary: _boundary,
    load, add, query, explain, serialize, restore,
    get size() { return points.length; },
    _idfOf: idfOf,   // exposed for tests/debug
  };
}

// Build an internal boundary only if the caller didn't inject one. Kept import-light: we import the factory from the single
// allowed sibling module. Done lazily so a caller that always injects `boundary` pays nothing.
import { makeRecallBoundary } from "./recallBoundary.js";
function _makeInternalBoundary() { return makeRecallBoundary(); }
