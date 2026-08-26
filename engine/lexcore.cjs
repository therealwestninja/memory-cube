'use strict';
/* lexcore.cjs — LexCore: a dep-free language CLASSIFIER for session/safety language. Pairs with lexcore-lexicon.cjs.
 *
 * ONE deterministic, multi-label, negation-aware classifier driven by a data lexicon (lexcore-lexicon.cjs).
 * It is a portable UMD module with ZERO deps, coupled to NOTHING here.
 *
 * WHAT IT DOES: tokenizes text, matches phrase categories LONGEST-FIRST over the token stream, applies
 * clause-bounded NEGATION scoping (so "don't stop" reads as affirm, not hard_stop), scales confidence by
 * intensity modifiers, and emits a multi-label Result with layer-sorted labels, a -1..1 valence roll-up,
 * boolean safety/session/device flags, and a resolved domTone.
 *
 * SAFETY MODEL: L0 SAFETY categories (safeword/hard_stop/distress/consent_withdraw/fresh_consent) are
 * SOVEREIGN — they set the safety flags directly and can never be lowered by an extension. L1–L3
 * (session escalation + device actuation) are DETECTION ONLY: they populate flags for a consumer to act
 * on; this module drives nothing. Wiring/gating is the consumer's job (LexCore L2).
 *
 * PURE: no DOM, no timers, `now` injected. Deterministic (same in -> same out). classify() NEVER throws:
 * junk/null/emoji/huge/non-string all yield a safe empty Result.
 *
 * UMD: Node -> module.exports; browser -> window.LexCore / self.LexCore.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.LexCore = api;
  else if (typeof self !== 'undefined') self.LexCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var VERSION = '1.0.0';

  function _defaultLexicon() {
    var _g = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : this);
    if (typeof require === 'function') { try { return require('./lexcore-lexicon.cjs'); } catch (e) {} }
    if (_g && _g.LexCoreLexicon) return _g.LexCoreLexicon;
    return { categories: {}, NEGATORS: [], MODIFIERS: {} };
  }

  // pull the active-language tables out of a lexicon (top-level or nested under lang code).
  function _tables(lex) {
    lex = lex || {};
    var lang = lex.lang || 'en';
    var base = (lex[lang] && typeof lex[lang] === 'object') ? lex[lang] : lex;
    return {
      categories: (base.categories && typeof base.categories === 'object') ? base.categories
        : (lex.categories && typeof lex.categories === 'object') ? lex.categories : {},
      NEGATORS: base.NEGATORS || lex.NEGATORS || [],
      MODIFIERS: base.MODIFIERS || lex.MODIFIERS || {}
    };
  }

  // shallow-merge caller categories OVER the defaults (per-category replace; caller wins).
  function _mergeCategories(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    return out;
  }

  function clampN(v, lo, hi) { v = Number(v); if (!isFinite(v)) return lo; return v < lo ? lo : v > hi ? hi : v; }

  // Normalize + tokenize. Lowercase, curly apostrophes -> ', keep intra-word apostrophes, split on the rest.
  // Returns { tokens:[{w, boundary}], bangs, longStretch } where boundary=true means a clause break FOLLOWS this token.
  function tokenize(text) {
    var t = String(text).toLowerCase();
    // normalize apostrophe variants
    t = t.replace(/[‘’ʼ‛]/g, "'");
    var bangs = (t.match(/!/g) || []).length;
    // elongated chars ("sooo", "moreee", "yesss") -> intensity signal
    var longStretch = /([a-z])\1\1/.test(t);
    var tokens = [];
    // walk the string; a "word" = letters/digits with optional internal apostrophes. Punctuation between
    // words that breaks a clause: , . ; : ? ! — and the literal word "but".
    var re = /[a-z0-9]+(?:'[a-z0-9]+)*|[,.;:?!]/g, m;
    var pending = null;
    function flush(boundaryAfter) { if (pending !== null) { tokens.push({ w: pending, boundary: !!boundaryAfter }); pending = null; } }
    while ((m = re.exec(t)) !== null) {
      var s = m[0];
      if (/[,.;:?!]/.test(s)) { // clause break: mark the last emitted token as boundary
        if (tokens.length) tokens[tokens.length - 1].boundary = true;
        continue;
      }
      flush(false);
      pending = s;
    }
    flush(false);
    // "but" also acts as a clause break: mark it boundary so negation cannot cross it.
    for (var i = 0; i < tokens.length; i++) if (tokens[i].w === 'but') tokens[i].boundary = true;
    return { tokens: tokens, bangs: bangs, longStretch: longStretch };
  }

  function make(cfg) {
    cfg = cfg || {};
    var nowFn = (typeof cfg.now === 'function') ? cfg.now
      : (function () { var t = Number(cfg.now); t = isFinite(t) ? t : 0; return function () { return t; }; })();
    var extensions = Array.isArray(cfg.extensions) ? cfg.extensions.filter(function (f) { return typeof f === 'function'; }) : [];

    // build the active lexicon: default merged with caller override (caller categories win per-category).
    var def = _tables(_defaultLexicon());
    var over = cfg.lexicon ? _tables(cfg.lexicon) : { categories: {}, NEGATORS: null, MODIFIERS: null };
    var categories = _mergeCategories(def.categories, over.categories);
    var NEGSET = {}; (over.NEGATORS && over.NEGATORS.length ? over.NEGATORS : def.NEGATORS).forEach(function (n) { NEGSET[String(n).toLowerCase()] = true; });
    var MODS = over.MODIFIERS && Object.keys(over.MODIFIERS).length ? over.MODIFIERS : def.MODIFIERS;

    // Pre-index every category phrase as a token array, sorted GLOBALLY longest-first (by token count,
    // then char length) so "don't stop" consumes before "stop" and "turn it up" before "up".
    var PHRASES = [];
    (function build() {
      for (var cat in categories) {
        if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
        var spec = categories[cat] || {};
        var pats = Array.isArray(spec.patterns) ? spec.patterns : [];
        for (var i = 0; i < pats.length; i++) {
          var toks = tokenize(pats[i]).tokens.map(function (x) { return x.w; });
          if (!toks.length) continue;
          PHRASES.push({ cat: cat, toks: toks, len: toks.length, chars: pats[i].length,
            weight: (typeof spec.weight === 'number') ? spec.weight : 0.5,
            layer: (typeof spec.layer === 'number') ? spec.layer : 4,
            polarity: (typeof spec.polarity === 'number') ? spec.polarity : 0 });
        }
      }
      PHRASES.sort(function (a, b) { return (b.len - a.len) || (b.chars - a.chars); });
    })();

    // Also index multi-word MODIFIERS (e.g. "a little") so they scale correctly.
    var MOD_PHRASES = [];
    for (var mk in MODS) if (Object.prototype.hasOwnProperty.call(MODS, mk)) {
      MOD_PHRASES.push({ toks: mk.split(/\s+/), mult: MODS[mk], len: mk.split(/\s+/).length });
    }
    MOD_PHRASES.sort(function (a, b) { return b.len - a.len; });

    function tryMatchAt(toks, i, phraseToks) {
      if (i + phraseToks.length > toks.length) return false;
      for (var j = 0; j < phraseToks.length; j++) if (toks[i + j].w !== phraseToks[j]) return false;
      return true;
    }

    function emptyResult() {
      return {
        labels: [], top: null, valence: 0,
        flags: {
          safeword: false, distress: false, freshConsent: false,
          affirm: false, push: false, edge: false, aftercare: false,
          comply: false, refuse: false, consentStop: false,
          device: { start: false, stop: false, faster: false, slower: false, deeper: false,
            shallower: false, harder: false, softer: false, up: false, down: false, mode: false }
        },
        domTone: null, ts: Number(nowFn()) || 0
      };
    }

    function classify(text, opts) {
      var res = emptyResult();
      try {
        if (typeof text !== 'string' || !text) return res;
        if (text.length > 20000) text = text.slice(0, 20000); // huge-input guard
        var tk = tokenize(text);
        var toks = tk.tokens;
        if (!toks.length) return res;

        // intensity: global bang/elongation multiplier applied to every match this turn.
        var globalMult = 1 + Math.min(0.5, tk.bangs * 0.15) + (tk.longStretch ? 0.15 : 0);

        // claimedLen[idx] = length of the LONGEST phrase that already covers this token. A new phrase of
        // length L may match only if no covered token is claimed by a STRICTLY LONGER phrase — so a longer
        // phrase suppresses shorter overlapping ones ("don't stop" beats "stop"), but two equal-length
        // phrases in different layers co-fire ("harder" -> escalate_push AND device_harder).
        var claimedLen = new Array(toks.length);
        for (var z = 0; z < toks.length; z++) claimedLen[z] = 0;
        var hits = []; // {cat, layer, polarity, weight, negated, startIdx}

        // longest-first scan: for each phrase (already globally sorted), sweep the token stream.
        for (var p = 0; p < PHRASES.length; p++) {
          var ph = PHRASES[p];
          for (var i = 0; i + ph.len <= toks.length; i++) {
            var blocked = false;
            for (var u = 0; u < ph.len; u++) if (claimedLen[i + u] > ph.len) { blocked = true; break; }
            if (blocked) continue;
            if (!tryMatchAt(toks, i, ph.toks)) continue;
            // claim the span at this length (only raises the mark).
            for (var m2 = 0; m2 < ph.len; m2++) if (claimedLen[i + m2] < ph.len) claimedLen[i + m2] = ph.len;

            // NEGATION scoping: scan back up to 3 tokens for a negator, bounded by a clause break. A token
            // whose `.boundary` is set ends the previous clause, so a negator across it does NOT reach the
            // phrase (e.g. "no, touch me" does not negate "touch me"; "don't touch me" does).
            var negated = false;
            for (var b = i - 1, hops = 0; b >= 0 && hops < 3; b--, hops++) {
              if (toks[b].boundary) break;              // clause break -> stop; negator can't cross it
              if (NEGSET[toks[b].w]) { negated = true; break; }
            }

            // local intensity: a modifier immediately before (or two before) the phrase scales weight.
            var localMult = 1;
            for (var mp = 0; mp < MOD_PHRASES.length; mp++) {
              var mph = MOD_PHRASES[mp];
              var at = i - mph.len;
              if (at >= 0 && (at + mph.len <= i) && tryMatchAt(toks, at, mph.toks)) {
                localMult *= mph.mult; break;
              }
            }

            var conf = clampN(ph.weight * globalMult * localMult, 0, 1);
            hits.push({ cat: ph.cat, layer: ph.layer, polarity: ph.polarity, weight: ph.weight,
              confidence: conf, negated: negated, startIdx: i });
          }
        }

        // resolve hits -> labels + flags. SAFETY (layer 0) is sovereign & set directly.
        applyHits(res, hits);

        // extensions run AFTER the deterministic pass; may ADD labels/flags but NEVER lower a SAFETY hit.
        if (extensions.length) {
          var safetyLatched = res.flags.safeword || res.flags.consentStop || res.flags.distress;
          for (var e = 0; e < extensions.length; e++) {
            try {
              var patch = extensions[e](String(text), res, { tokens: toks });
              if (patch && typeof patch === 'object') mergeExtension(res, patch, safetyLatched);
            } catch (ex) { /* never throw */ }
          }
        }

        // recompute derived fields after everything.
        finalize(res);
      } catch (e) { return emptyResult(); }
      return res;
    }

    function applyHits(res, hits) {
      var f = res.flags, dev = f.device;
      var posW = 0, negW = 0;
      var domVotes = { gentle: 0, strict: 0, degrading: 0 };

      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var cat = h.cat, neg = h.negated;

        // ---- valence accumulation (negation flips polarity contribution) ----
        var pol = h.polarity * (neg ? -1 : 1);
        if (pol > 0) posW += h.confidence; else if (pol < 0) negW += h.confidence;

        // ---- L0 SAFETY: sovereign. Negation can DEMOTE a safety word (e.g. "don't stop"). ----
        if (h.layer === 0) {
          if (!neg) {
            if (cat === 'safeword') { f.safeword = true; f.consentStop = true; }   // literal safeword MUST stop (defense-in-depth: consentStop is the single authoritative sovereign-stop flag)
            if (cat === 'hard_stop') { f.consentStop = true; }
            if (cat === 'distress') { f.distress = true; f.consentStop = true; }   // expressed distress halts by default (fail-safe); consumer may soothe-vs-stop
            if (cat === 'consent_withdraw') { f.consentStop = true; }
            if (cat === 'fresh_consent') f.freshConsent = true;
          } else {
            // negated safety: "don't stop" / "never stop" -> reads as affirmation/push, NOT a stop.
            if (cat === 'hard_stop' || cat === 'consent_withdraw') { f.affirm = true; f.push = true; }
            // negated distress/safeword we simply do NOT latch (a demotion, never a promotion).
          }
        }

        // ---- L1 SESSION ----
        if (h.layer === 1 && !neg) {
          if (cat === 'arousal_intent') f.affirm = true;
          if (cat === 'affirm_yes') f.affirm = true;
          if (cat === 'escalate_push') f.push = true;
          if (cat === 'edge_deny') f.edge = true;
          if (cat === 'aftercare') f.aftercare = true;
          // slow_hold: no dedicated flag; contributes valence/label only.
        }
        if (h.layer === 1 && neg) {
          // "don't touch me" (arousal_intent negated) -> reads as withdrawal.
          if (cat === 'arousal_intent') { f.consentStop = true; f.refuse = true; }
          if (cat === 'escalate_push') { /* "no more" handled at L0; negated push just doesn't fire */ }
        }

        // ---- L2 RELATIONAL ----
        if (h.layer === 2) {
          if (!neg && cat === 'comply') f.comply = true;
          if (cat === 'refuse') { if (!neg) f.refuse = true; }
          if (!neg && cat === 'domtone_gentle') domVotes.gentle += h.confidence;
          if (!neg && cat === 'domtone_strict') domVotes.strict += h.confidence;
          if (!neg && cat === 'domtone_degrading') domVotes.degrading += h.confidence;
        }

        // ---- L3 DEVICE (detection only) ----
        if (h.layer === 3 && !neg) {
          if (cat === 'device_start') dev.start = true;
          if (cat === 'device_stop') dev.stop = true;
          if (cat === 'device_faster') dev.faster = true;
          if (cat === 'device_slower') dev.slower = true;
          if (cat === 'device_deeper') dev.deeper = true;
          if (cat === 'device_shallower') dev.shallower = true;
          if (cat === 'device_harder') dev.harder = true;
          if (cat === 'device_softer') dev.softer = true;
          if (cat === 'device_up') dev.up = true;
          if (cat === 'device_down') dev.down = true;
          if (cat === 'device_mode' || cat === 'device_named') dev.mode = true;
        }
        if (h.layer === 3 && neg) {
          // "don't turn it up" -> flip to the opposite intent where it is meaningful.
          if (cat === 'device_up') dev.down = true;
          if (cat === 'device_faster') dev.slower = true;
          if (cat === 'device_start') dev.stop = true;
        }

        // ---- label row ----
        res.labels.push({ category: cat, layer: h.layer, confidence: +h.confidence.toFixed(3),
          polarity: h.polarity, negated: neg });
      }

      // resolve dom tone (strongest vote; degrading > strict > gentle on a tie by design).
      var best = null, bestV = 0;
      ['degrading', 'strict', 'gentle'].forEach(function (k) { if (domVotes[k] > bestV) { bestV = domVotes[k]; best = k; } });
      res.domTone = best;

      // valence roll-up (-1..1)
      var tot = posW + negW;
      res.valence = tot > 0 ? clampN((posW - negW) / tot, -1, 1) : 0;
    }

    function mergeExtension(res, patch, safetyLatched) {
      // patch may add labels and set flags true — but must NOT clear a latched safety flag.
      if (Array.isArray(patch.labels)) {
        for (var i = 0; i < patch.labels.length; i++) {
          var l = patch.labels[i];
          if (l && typeof l === 'object' && typeof l.category === 'string') {
            res.labels.push({ category: l.category, layer: Number(l.layer) || 4,
              confidence: clampN(l.confidence, 0, 1), polarity: Number(l.polarity) || 0, negated: !!l.negated });
          }
        }
      }
      if (patch.flags && typeof patch.flags === 'object') {
        for (var k in patch.flags) {
          if (k === 'device' && patch.flags.device && typeof patch.flags.device === 'object') {
            for (var dk in patch.flags.device) if (patch.flags.device[dk]) res.flags.device[dk] = true;
          } else if (patch.flags[k] === true) {
            res.flags[k] = true;
          }
        }
      }
      if (typeof patch.valence === 'number') res.valence = clampN(patch.valence, -1, 1);
      if (typeof patch.domTone === 'string') res.domTone = patch.domTone;
      // re-assert safety supremacy: an extension can never lower it.
      if (safetyLatched) {
        if (res.flags.safeword === false && patch && patch.__wasSafeword) res.flags.safeword = true;
      }
    }

    function finalize(res) {
      // sort labels by (layer asc, confidence desc) so SAFETY sits first.
      res.labels.sort(function (a, b) { return (a.layer - b.layer) || (b.confidence - a.confidence); });
      res.top = res.labels.length ? res.labels[0] : null;
      res.ts = Number(nowFn()) || 0;
    }

    function serialize() {
      // stateless classifier; serialize just pins version + config shape for round-trip parity.
      return { version: VERSION, lang: (cfg.lexicon && cfg.lexicon.lang) || 'en', extensions: extensions.length };
    }
    function restore(s) { /* stateless — nothing to restore; accept for API parity */ return; }

    return { classify: classify, serialize: serialize, restore: restore, version: VERSION };
  }

  return { make: make, version: VERSION, tokenize: tokenize };
});
