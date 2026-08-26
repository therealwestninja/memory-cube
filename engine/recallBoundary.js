// recallBoundary.js — the point-set PRE-FILTER for faceted memory recall. It runs
// BEFORE any distance/relevance is computed and removes memory points that are out of bounds — so an offset/analogy can bias
// DIRECTION but can NEVER grant reach past a boundary (R1), and a tombstoned or forgotten point is unreachable from EVERY
// axis and offset (R2). The whole security argument of the hypercube rests on these being HARD PREDICATES applied at the
// point-set level, never soft weights that a high enough similarity could overwhelm.
//
// It is intentionally standalone and reusable — valuable for ANY faceted recall, with or without the cube.
// cubeRecall.js calls `filter()` first and only scores the survivors.
//
// PURE: no clock/random/network/IO. `asOf` (the valid-time view) is supplied per query by the caller, never read from a
// clock here. State (tombstones + per-scope forget-floors) is small + serialize()/restore()-able. Node-testable.
//
// A memory POINT carries the facets this filter gates on: { id, ts, validFrom, validTo, scope }
//   - id       — stable identity (for tombstoning)
//   - ts       — when the memory was formed (for the forget-floor comparison)
//   - validFrom/validTo — the valid-time interval (validTo=null → still current); absent → always-valid
//   - scope    — an isolation compartment ("public" | "dm:<peer>" | "sealed-intimate" | …); absent → "public" (unrestricted)
// A query CONTEXT says who is asking and in what view:
//   { scope = "public", allowScopes = [], asOf }
//   - scope       — the compartment the query runs in; a point's own scope is readable when it MATCHES this…
//   - allowScopes — …or is in this EXPLICIT, caller-granted allow-list (a deliberate, logged read-only cross-context
//                   merge — a grant the caller makes on purpose, never an implicit reach). Never a write path.
//   - asOf        — the valid-time view; when given, a point must be valid at that instant. Omit → all-time (no time gate).

export function makeRecallBoundary({ state = null } = {}) {
  const tombstones = new Set();   // permanently-unreachable ids (block / sovereign-forget) — checked before everything
  const floors = new Map();       // scope -> forget-floor ts: in that scope, any point with ts < floor is unreachable
  if (state) restore(state);

  const scopeOf = (p) => (p && p.scope) || "public";
  const validAt = (p, at) => {
    if (at == null) return true;                                  // no time view → all-time
    const from = Number.isFinite(+p.validFrom) ? +p.validFrom : -Infinity;
    const to = (p.validTo == null) ? Infinity : +p.validTo;       // null validTo = still current
    return from <= at && at < to;
  };

  // permanently remove a point from EVERY view/offset (operator block, sovereign-forget). Sticky — survives restore.
  function tombstone(id) { if (id != null) tombstones.add(String(id)); }
  function untombstone(id) { return tombstones.delete(String(id)); }   // (rare; block is meant to be permanent — exposed for symmetry/tests)
  const isTombstoned = (id) => tombstones.has(String(id));

  // set a forget-floor for a scope: everything formed before `ts` in that scope becomes unreachable. OUTLIVES a later
  // "remember me" (the floor only ever moves FORWARD unless explicitly cleared) so erased history can't resurface (R2).
  function setFloor(scope, ts) { const s = String(scope || "public"), t = Number(ts) || 0; floors.set(s, Math.max(floors.get(s) || 0, t)); return floors.get(s); }
  function clearFloor(scope) { return floors.delete(String(scope || "public")); }   // explicit, deliberate (e.g. operator reset)
  const floor = (scope) => floors.get(String(scope || "public")) || 0;

  // THE predicate — is this point reachable in this context? Order matters: the cheapest, most absolute bans first.
  // Returns { ok, reason } so a caller can LOG why a point was excluded (inspectability: the boundary-first assertion).
  function reachable(point, ctx = {}) {
    if (!point || point.id == null) return { ok: false, reason: "no-id" };
    if (isTombstoned(point.id)) return { ok: false, reason: "tombstoned" };            // R2 — from every axis/offset
    const ps = scopeOf(point);
    if (Number.isFinite(+point.ts) && +point.ts < floor(ps)) return { ok: false, reason: "forget-floor" };   // R2
    if (ps !== "public") {                                                             // R1 — hard isolation, never a weight
      const inScope = ps === (ctx.scope || "public");
      const granted = Array.isArray(ctx.allowScopes) && ctx.allowScopes.includes(ps);
      if (!inScope && !granted) return { ok: false, reason: "scope" };
    }
    if (!validAt(point, ctx.asOf)) return { ok: false, reason: "valid-time" };         // structured valid-time view
    return { ok: true };
  }

  // filter a candidate point-set → { kept, removed:[{id,reason}] }. This is what a recall runs BEFORE distance/relevance.
  function filter(points, ctx = {}) {
    const kept = [], removed = [];
    for (const p of (points || [])) { const r = reachable(p, ctx); if (r.ok) kept.push(p); else removed.push({ id: p && p.id, reason: r.reason }); }
    return { kept, removed };
  }

  function serialize() { return { tombstones: [...tombstones], floors: Object.fromEntries(floors) }; }
  function restore(s) {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.tombstones)) for (const id of s.tombstones) tombstones.add(String(id));
    if (s.floors && typeof s.floors === "object") for (const [k, v] of Object.entries(s.floors)) floors.set(String(k), Number(v) || 0);
  }

  return { tombstone, untombstone, isTombstoned, setFloor, clearFloor, floor, reachable, filter, serialize, restore,
    tombstoneCount: () => tombstones.size };
}
