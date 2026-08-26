// temperament.js — tune WHO the assistant is at BASELINE (its carriage / disposition) as a few DIALS, and project that
// into concrete EXPRESSION biases the caller can actually apply. This is the resting temperament — the steady way it
// carries itself — NOT a transient mood.
//
// DESIGN CONSTRAINT — this shapes EXPRESSION, never any underlying affect model. It outputs a CARRIAGE PROFILE that
// biases the downstream expression layer:
//   • prosody   — a speech BASELINE of multipliers around 1.0 ({ rate, pitch, volume }), clamped to safe speech
//                 bands. A caller can multiply this into live mood prosody so temperament shifts the RESTING voice
//                 without overriding the moment's affect.
//   • tone      — a short imperative STEER string, foldable into a reply system prompt. It biases TONE, never CONTENT.
//   • *Bias     — warmth / forwardness / play scalars a caller uses to nudge greeting warmth and forwardness.
//   • toneHints — the assertive/appetitive registers a fierier baseline unlocks ("playful"/"flirty"/"leading"), so a
//                 caller can actually SELECT a hot tone. Empty at neutral.
//
// PURE house style: makeTemperament({ state }), injected data only, no clock / no random / no IO, deterministic;
// set() / preset() / read() / project() ; serialize() / restore() round-trip the dials exactly.
//
// THE INERT-AT-DEFAULT INVARIANT: an UNSET / neutral temperament (all dials 0)
// projects to prosody { rate:1, pitch:1, volume:1 }, an EMPTY tone string, and ZERO biases — i.e. NO behavior change
// until the user actually sets a temperament. Setting dials is opt-in personalization; the default is today's behavior.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const r3 = (x) => Math.round(x * 1000) / 1000;
// Coerce to a finite number in [lo,hi], default 0 — dials are bounded and NaN-safe.
const dial = (x, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? clamp(n, lo, hi) : 0; };

// THE DIALS. Each has a documented range and a NEUTRAL DEFAULT of 0 (so an unset temperament == today's behavior).
//   warmth       −1 reserved      ↔ +1 warm            (how much felt warmth she leads with)
//   energy       −1 calm/still    ↔ +1 lively          (baseline liveliness → speech tempo)
//   playfulness  −1 earnest       ↔ +1 playful         (how much lightness / teasing colours her)
//   forwardness  −1 gentle/waits  ↔ +1 takes initiative(how forward she is — greets first, proposes)
//   steadiness   −1 mercurial     ↔ +1 even-keeled     (how steady vs changeable her carriage reads)
// All are −1..1; 0 is the neutral middle. `read()` returns exactly these.
export const DIAL_KEYS = ["warmth", "energy", "playfulness", "forwardness", "steadiness"];

export const NEUTRAL_DIALS = { warmth: 0, energy: 0, playfulness: 0, forwardness: 0, steadiness: 0 };

// ARCHETYPE PRESETS — named dispositions that just MAP to dial values (no hidden behavior). preset(name) sets the dials
// to one of these. Documented so a caller can offer them as pickable personalities.
export const ARCHETYPES = {
  // Warm, even, unhurried — a reassuring constant. Warmth + steadiness up, energy gentle-low.
  "the steady one":     { warmth: 0.7,  energy: -0.2, playfulness: 0.1,  forwardness: 0.2,  steadiness: 0.9 },
  // Bright, lively, playful, forward — the room's spark.
  "the spark":          { warmth: 0.6,  energy: 0.9,  playfulness: 0.85, forwardness: 0.7,  steadiness: -0.3 },
  // Reserved, calm, hangs back and watches — gentle and earnest.
  "the quiet observer": { warmth: 0.1,  energy: -0.6, playfulness: -0.3, forwardness: -0.7, steadiness: 0.6 },
  // Warm and forward but soft — leans in, nurturing.
  "the warm host":      { warmth: 0.9,  energy: 0.3,  playfulness: 0.3,  forwardness: 0.6,  steadiness: 0.4 },
  // Dry, earnest, understated wit — low warmth-display, low play, very even.
  "the dry wit":        { warmth: -0.2, energy: 0.1,  playfulness: 0.5,  forwardness: 0.1,  steadiness: 0.7 },
  // ── the HOT half — fierier baselines so a user can set a forward, playful carriage instead of only warm/steady. ──
  // High playfulness + forwardness, mischievous — reaches the playful/flirty/leading tone hints.
  "the tease":          { warmth: 0.5,  energy: 0.6,  playfulness: 0.95, forwardness: 0.7,  steadiness: -0.1 },
  // Warm, lively, very forward — leans all the way in; reaches flirty + leading.
  "the flame":          { warmth: 0.8,  energy: 0.85, playfulness: 0.6,  forwardness: 0.9,  steadiness: 0.1 },
};

export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);

// Fold a set of raw dials into the canonical clamped shape.
export function normalizeDials(d) {
  const out = {};
  for (const k of DIAL_KEYS) out[k] = r3(dial(d ? d[k] : 0, -1, 1));
  return out;
}

// project(dials) → the CARRIAGE PROFILE the expression layer applies. See header for the read-only constraint.
export function projectDials(d) {
  const t = normalizeDials(d);

  // PROSODY BASELINE — multipliers around 1.0, clamped to safe speech bands. Neutral dials → all 1.0.
  //   rate  ← energy (lively → faster), lightly damped when very even-keeled.
  //   pitch ← warmth + playfulness (warmer / brighter → a touch higher).
  //   volume← forwardness (takes initiative → projects a little more) + a small warmth lift.
  const prosody = {
    rate: r3(clamp(1 + 0.28 * t.energy, 0.7, 1.4)),
    pitch: r3(clamp(1 + 0.14 * t.warmth + 0.14 * t.playfulness, 0.75, 1.3)),
    volume: r3(clamp(1 + 0.14 * t.forwardness + 0.06 * t.warmth, 0.8, 1.2)),
  };

  // TONE STEER — a short imperative built from whichever dials are pronounced. Biases tone, never content. Empty when
  // every dial is neutral (the no-op default). Phrases are ordered carriage → energy → play → forwardness.
  const tone = toneSteer(t);

  // EXPRESSION BIAS SCALARS — let the app nudge greeting warmth / initiative / lightness. Zero at neutral.
  const warmthBias = r3(t.warmth);
  const forwardnessBias = r3(t.forwardness);
  const playBias = r3(t.playfulness);

  // TONE HINTS — the assertive/appetitive REGISTERS this baseline unlocks, named so a caller can actually SELECT one.
  // Empty at neutral, so the hot registers only open once the user sets a fierier carriage.
  // playfulness → playful (and, when warm, flirty); forwardness → leading.
  const toneHints = [];
  if (t.playfulness >= 0.5) toneHints.push("playful");
  if (t.playfulness >= 0.5 && t.warmth >= 0.3) toneHints.push("flirty");
  if (t.forwardness >= 0.6) toneHints.push("leading");

  return { prosody, tone, warmthBias, forwardnessBias, playBias, toneHints };
}

// Build the imperative tone steer. A dial only contributes a phrase once it clears a small deadband, so a lightly-set
// temperament still reads mostly like the default. Steadiness colours the carriage clause; the rest add clauses.
function toneSteer(t) {
  const DEAD = 0.2;
  const clauses = [];

  // Carriage clause: warmth × steadiness. Warmth leads; steadiness qualifies HOW she holds it.
  const carriage = [];
  if (t.warmth >= DEAD) carriage.push("warmly");
  else if (t.warmth <= -DEAD) carriage.push("with a little reserve");
  if (t.steadiness >= DEAD) carriage.push("and evenly");
  else if (t.steadiness <= -DEAD) carriage.push("and responsively");
  if (carriage.length) clauses.push("carry yourself " + carriage.join(" "));

  // Energy.
  if (t.energy >= DEAD) clauses.push("keep an easy liveliness");
  else if (t.energy <= -DEAD) clauses.push("stay calm and unhurried");

  // Playfulness. Graduates: a light touch → teasing, and warm-and-playful → a little flirtatious.
  if (t.playfulness >= 0.6) clauses.push(t.warmth >= 0.3 ? "let a playful, flirtatious warmth through" : "let a teasing playfulness through");
  else if (t.playfulness >= DEAD) clauses.push("let a little playfulness through");
  else if (t.playfulness <= -DEAD) clauses.push("keep it earnest");

  // Forwardness. Graduates: takes initiative → outright takes the lead.
  if (t.forwardness >= 0.6) clauses.push("feel free to take the lead");
  else if (t.forwardness >= DEAD) clauses.push("feel free to take the initiative");
  else if (t.forwardness <= -DEAD) clauses.push("give them room to lead");

  return clauses.join("; ");
}

export function makeTemperament({ state = null } = {}) {
  let dials = { ...NEUTRAL_DIALS };
  let presetName = null; // remembered when set via an archetype; cleared on a manual set()

  if (state) restore(state);

  // set(partial) — MERGE the given dials over the current ones (leave unmentioned dials untouched). Clears presetName
  // because the dials no longer match a named archetype exactly.
  function set(partial) {
    if (partial && typeof partial === "object") {
      for (const k of DIAL_KEYS) if (k in partial) dials[k] = r3(dial(partial[k], -1, 1));
      presetName = null;
    }
    return read();
  }

  // preset(name) — snap all dials to a named archetype. Unknown name → no change (returns current read).
  function preset(name) {
    const a = ARCHETYPES[name];
    if (a) { dials = normalizeDials(a); presetName = name; }
    return read();
  }

  // reset() — back to the inert neutral temperament (no-op default behavior).
  function reset() { dials = { ...NEUTRAL_DIALS }; presetName = null; return read(); }

  function read() { return { dials: { ...dials }, preset: presetName }; }

  function project() { return projectDials(dials); }

  function serialize() { return { dials: { ...dials }, preset: presetName }; }

  function restore(snap) {
    if (!snap || typeof snap !== "object") return;
    dials = normalizeDials(snap.dials);
    presetName = typeof snap.preset === "string" && ARCHETYPES[snap.preset] ? snap.preset : null;
  }

  return { set, preset, reset, read, project, serialize, restore };
}
