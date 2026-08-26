// compartments.mjs — the compartment REGISTRY loader + the generalized router. One classifier pass + one regex per
// compartment decides where an input lives; recallBoundary's free-form scope does the enforcement. NSFW was the first
// tenant; the mechanism is generic ("business or pleasure" — or medical, finances, venting, a client, a surprise).
//
// Routing precedence per item (first hit wins, no model call anywhere):
//   1. explicit prefix tag ("vent: ...", "medical: ...") — the user SAID the compartment; silent route, tag kept.
//   2. per-item user override (persona.scopeOverrides[text] = "public" | <compartment id>) — an answered question.
//   3. STRONG lexicon phrase (or a stock LexCore session category on a compartment declaring stockLayers) — silent.
//   4. AMBIGUOUS single word — never silent: routes to the FIRST candidate compartment (leak-safe default) and emits a
//      pending "did you mean...?" question listing every candidate.
//   5. nothing — public.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = join(HERE, "compartments.json");
const _require = createRequire(import.meta.url);
const LexCore = _require("./engine/lexcore.cjs");

export function loadCompartments() {
  try {
    if (existsSync(REGISTRY_FILE)) {
      const j = JSON.parse(readFileSync(REGISTRY_FILE, "utf8").replace(/^﻿/, ""));
      const list = (j.compartments || []).filter((c) => c && c.id && c.scope);
      if (list.length) return list;
    }
  } catch (e) { console.error("compartments.json unreadable:", e.message); }
  return [];
}

// resolve a user-facing name (compartment id OR raw scope string) to a scope string; null if unknown.
export function scopeFor(name, compartments = loadCompartments()) {
  const n = String(name || "").trim();
  if (!n) return null;
  const c = compartments.find((c) => c.id === n || c.scope === n);
  return c ? c.scope : null;
}

export function makeRouter(compartments = loadCompartments()) {
  // one merged classifier: a category per compartment's strong list. Category name carries the compartment id.
  const categories = {};
  for (const c of compartments) {
    if (Array.isArray(c.strong) && c.strong.length)
      categories["cpt_" + c.id] = { layer: 1, weight: 0.7, polarity: 1, patterns: c.strong };
  }
  const classifier = LexCore.make({ lexicon: { categories } });
  const byCategory = new Map(compartments.map((c) => ["cpt_" + c.id, c]));
  // LexCore stock CATEGORY -> owning compartment. An explicit allowlist, never a whole layer: generic session words
  // ("please" -> affirm_yes) would otherwise drag ordinary profile text into a sealed scope.
  const stockOwner = new Map();
  for (const c of compartments) for (const cat of (c.stockCategories || [])) if (!stockOwner.has(cat)) stockOwner.set(cat, c);
  const ambRes = compartments.map((c) => ({
    c,
    re: Array.isArray(c.ambiguous) && c.ambiguous.length
      ? new RegExp("\\b(" + c.ambiguous.join("|") + ")\\b", "gi") : null,
  }));

  // analyze(text) -> { route: <compartment id>|null, ask: bool, terms: [], candidates: [ids] }
  function analyze(text) {
    const s = String(text || "");
    const lower = s.toLowerCase();
    for (const c of compartments)
      for (const p of (c.prefixes || []))
        if (lower.startsWith(String(p).toLowerCase())) return { route: c.id, ask: false, terms: [], candidates: [] };
    try {
      const r = classifier.classify(s);
      for (const l of (r.labels || [])) {
        const own = byCategory.get(l.category) || stockOwner.get(l.category);
        if (own) return { route: own.id, ask: false, terms: [], candidates: [] };
      }
    } catch {}
    const candidates = [], terms = [];
    for (const { c, re } of ambRes) {
      if (!re) continue;
      re.lastIndex = 0;
      const m = [...new Set((s.match(re) || []).map((t) => t.toLowerCase()))];
      if (m.length) { candidates.push(c.id); terms.push(...m); }
    }
    if (candidates.length) return { route: candidates[0], ask: true, terms: [...new Set(terms)], candidates };
    return { route: null, ask: false, terms: [], candidates: [] };
  }

  // routeItems(items, overrides) -> { pub: [], byCpt: { id: [items] }, pending: [{text, terms, candidates}] }
  function routeItems(items, overrides = {}) {
    const pub = [], byCpt = {}, pending = [];
    const put = (id, t) => { (byCpt[id] = byCpt[id] || []).push(t); };
    for (const t of (items || []).map((x) => String(x).trim()).filter(Boolean)) {
      let ov = overrides[t];
      if (ov === "sealed") ov = "intimate";        // back-compat with the single-compartment era
      if (ov === "public") { pub.push(t); continue; }
      if (ov && compartments.some((c) => c.id === ov)) { put(ov, t); continue; }
      const a = analyze(t);
      if (!a.route) { pub.push(t); continue; }
      put(a.route, t);
      if (a.ask) pending.push({ text: t, terms: a.terms, candidates: a.candidates });
    }
    return { pub, byCpt, pending };
  }

  return { analyze, routeItems, compartments };
}
