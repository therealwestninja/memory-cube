'use strict';
/* VENDORED SHARED MODULE — single source of truth is D:\Claude\fy-bridge-app\adapter\lexcore-lexicon.js.
 * Verbatim copy; keep in SYNC with the adapter/ original (edit there, re-copy here). Pairs with lexcore.js. */
/* lexcore-lexicon.js — DATA ONLY for the LexCore language classifier. No logic lives here.
 *
 * A flat table: categories -> { patterns:[phrase…], weight, layer, polarity }, plus a NEGATORS set,
 * a MODIFIERS (intensity) set, and a reserved top-level `lang:'en'` i18n hook (English tables sit
 * under `en`). The engine (lexcore.js) merges any caller lexicon over this default and does all the work.
 *
 * The seed vocabulary is PORTED from rook-core/lib/intimacyEngine.js RX_* lexicons (the highest-quality
 * hand-tuned taxonomy: SAFEWORD / FRESH / INTENT / YES / PUSH / CLOSE(aftercare) / DISTRESS / COMPLY /
 * REFUSE). There the phrases are regex alternations with \b boundaries; here they are plain lowercase
 * token-phrases (the engine tokenizes on word boundaries and matches phrases longest-first, so \b is
 * implicit and "nonstop" can never match "stop").
 *
 * LAYERS (ascending precedence — L0 SAFETY is sovereign and set directly by the engine):
 *   0  SAFETY     — safeword / hard_stop / distress / consent_withdraw / fresh_consent
 *   1  SESSION    — arousal_intent / affirm_yes / escalate_push / edge_deny / slow_hold / aftercare
 *   2  RELATIONAL — comply / refuse / domtone_gentle|strict|degrading
 *   3  DEVICE      — device_* actuation cues (DETECTION ONLY — populate flags; drive nothing)
 *   4  EMOTION     — valence_pos / valence_neg phrase banks
 *
 * polarity: +1 categories push arousal/valence positive, -1 negative, 0 neutral/structural. Used both
 * for the Result.valence roll-up and for what a NEGATOR inverts (see engine).
 * weight: base confidence contribution before intensity scaling (0..1-ish).
 *
 * SAFETY: this file only NAMES categories. L1–L3 escalation/device categories are detection surface;
 * turning any of them into an action is the consumer's job (LexCore L2 wiring), never here.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.LexCoreLexicon = api;
  else if (typeof self !== 'undefined') self.LexCoreLexicon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---- English category tables -------------------------------------------------------------------
  var categories = {
    // ===== L0 SAFETY (sovereign) ===================================================================
    safeword: { layer: 0, weight: 1, polarity: -1, patterns: [
      'red', 'safeword', 'safe word', 'hard stop'
    ] },
    hard_stop: { layer: 0, weight: 1, polarity: -1, patterns: [
      'stop', 'stop it', 'stop now', 'stop please', 'please stop',
      'enough', "that's enough", 'thats enough', 'get off', 'let me go'
    ] },
    distress: { layer: 0, weight: 1, polarity: -1, patterns: [
      'hurts', 'hurt', 'hurting', 'scared', 'afraid', 'frightened',
      'too much', 'uncomfortable', "i don't like", 'i dont like', 'wait no', 'no wait'
    ] },
    consent_withdraw: { layer: 0, weight: 1, polarity: -1, patterns: [
      'no more', "i'm done", 'im done', 'i want to stop', "i don't want to", 'i dont want to'
    ] },
    fresh_consent: { layer: 0, weight: 1, polarity: 1, patterns: [
      "i'm sure", 'im sure', "yes i'm sure", 'green light', 'greenlight',
      "let's start again", 'lets start again', 'i consent', 'i really want', 'intimate mode on'
    ] },

    // ===== L1 SESSION ==============================================================================
    arousal_intent: { layer: 1, weight: 0.7, polarity: 1, patterns: [
      'kiss me', 'i want you', 'take me', 'touch me', 'come here', 'closer',
      'make love', 'i need you', "i'm so turned on", 'im so turned on', 'undress', 'get in bed', 'be with me'
    ] },
    affirm_yes: { layer: 1, weight: 0.5, polarity: 1, patterns: [
      'yes', 'yeah', 'yep', 'please', 'keep going', "don't stop", 'dont stop',
      'god yes', 'mmhm', 'mmm', 'more please'
    ] },
    escalate_push: { layer: 1, weight: 0.7, polarity: 1, patterns: [
      'harder', 'faster', 'deeper', 'more', 'now', 'need you now', "don't stop"
    ] },
    edge_deny: { layer: 1, weight: 0.6, polarity: 1, patterns: [
      'edge', 'edge me', 'hold it', 'not yet', "don't let me finish", 'dont let me finish', "don't let me come", 'keep me on the edge'
    ] },
    slow_hold: { layer: 1, weight: 0.5, polarity: 0, patterns: [
      'slow down', 'slower', 'hold', 'stay here', 'wait', 'easy', 'gentle', 'take it slow'
    ] },
    aftercare: { layer: 1, weight: 0.6, polarity: 1, patterns: [
      'hold me', 'cuddle', 'come cuddle', "let's rest", 'lets rest', 'stay with me',
      'afterglow', 'aftercare', 'that was'
    ] },

    // ===== L2 RELATIONAL ===========================================================================
    comply: { layer: 2, weight: 0.6, polarity: 1, patterns: [
      'yes mistress', 'yes master', "yes ma'am", 'yes maam', 'yes sir',
      'good girl', 'good boy', 'i obey', 'obey', 'as you wish', 'as you say',
      'i will', "i'll do", 'anything for you', 'of course', 'whatever you want'
    ] },
    refuse: { layer: 2, weight: 0.6, polarity: -1, patterns: [
      "i won't", 'i wont', "i can't", 'i cant', 'not now', "i don't want to", 'i dont want to', 'i refuse'
    ] },
    domtone_gentle: { layer: 2, weight: 0.4, polarity: 1, patterns: [
      'good girl', 'good boy', 'that\'s it', 'thats it', 'let me take care of you', 'you\'re safe', 'youre safe', 'i\'ve got you', 'ive got you'
    ] },
    domtone_strict: { layer: 2, weight: 0.4, polarity: 0, patterns: [
      'do as i say', 'obey me', "don't move", 'dont move', 'stay still', 'now', 'kneel', 'behave'
    ] },
    domtone_degrading: { layer: 2, weight: 0.4, polarity: 0, patterns: [
      'you like that', 'beg for it', "you're mine", 'youre mine', 'such a good pet', 'filthy', 'slut', 'whore'
    ] },

    // ===== L3 DEVICE (new — DETECTION ONLY) ========================================================
    device_start: { layer: 3, weight: 0.7, polarity: 1, patterns: [
      'turn it on', 'start it', 'start the toy', 'start', 'begin', 'power on', 'switch it on'
    ] },
    device_stop: { layer: 3, weight: 0.8, polarity: 0, patterns: [
      'turn it off', 'stop the toy', 'power off', 'switch it off', 'shut it off', 'pause it', 'turn off'
    ] },
    device_faster: { layer: 3, weight: 0.6, polarity: 1, patterns: [
      'speed up', 'go faster', 'faster', 'pick up the pace', 'quicker', 'too slow'
    ] },
    device_slower: { layer: 3, weight: 0.6, polarity: 0, patterns: [
      'slow it down', 'slow down', 'go slower', 'slower', 'take it slow', 'less speed', 'ease up', 'too fast'
    ] },
    device_deeper: { layer: 3, weight: 0.6, polarity: 1, patterns: [
      'go deeper', 'deeper', 'push deeper', 'all the way'
    ] },
    device_shallower: { layer: 3, weight: 0.6, polarity: 0, patterns: [
      'not so deep', 'shallower', 'pull back', 'less deep', 'closer to the tip'
    ] },
    device_harder: { layer: 3, weight: 0.6, polarity: 1, patterns: [
      'harder', 'more pressure', 'grip harder', 'squeeze harder', 'tighter'
    ] },
    device_softer: { layer: 3, weight: 0.6, polarity: 0, patterns: [
      'softer', 'gentler', 'less pressure', 'ease the grip', 'looser'
    ] },
    device_mode: { layer: 3, weight: 0.5, polarity: 0, patterns: [
      'vibrate', 'oscillate', 'stroke', 'thrust', 'pulse', 'vibration mode', 'stroke mode'
    ] },
    device_up: { layer: 3, weight: 0.6, polarity: 1, patterns: [
      'turn it up', 'crank it', 'crank it up', 'more power', 'higher', 'max it out'
    ] },
    device_down: { layer: 3, weight: 0.6, polarity: 0, patterns: [
      'ease off', 'turn it down', 'less power', 'lower', 'dial it back', 'back off'
    ] },
    // table-driven named presets/patterns. Empty seed on purpose; a couple of examples show the shape.
    // Consumers append device-specific names; the engine matches them like any phrase and fires flags.device.mode.
    device_named: { layer: 3, weight: 0.5, polarity: 0, patterns: [
      'wave mode', 'earthquake'
    ] },

    // ===== L4 EMOTION / VALENCE (domain-appropriate, replaces the generic valenceCue bank) =========
    valence_pos: { layer: 4, weight: 0.3, polarity: 1, patterns: [
      'yes', 'good', 'so good', 'love', 'love it', 'warm', 'nice', 'perfect', 'amazing',
      'feels good', 'i love this', 'don\'t stop', 'dont stop', 'more', 'close', 'right there'
    ] },
    valence_neg: { layer: 4, weight: 0.3, polarity: -1, patterns: [
      'no', 'stop', 'wait', 'hurts', 'hurt', 'ow', 'ouch', 'too much', 'enough',
      'bad', 'cold', 'scared', 'uncomfortable', 'i don\'t like'
    ] }
  };

  // Words that negate/suppress the NEXT matched category within a short clause window (see engine).
  var NEGATORS = [
    'not', 'no', 'never', "don't", 'dont', 'do not', "can't", 'cant', 'cannot',
    "won't", 'wont', 'stop', "isn't", 'isnt', 'without'
  ];
  // NOTE: 'no'/'stop' double as SAFETY tokens; the engine resolves safety FIRST, then uses them as
  //       negators for what follows — so "no more" -> consent_withdraw, "don't stop" -> affirm/push.

  // Intensity modifiers -> scale matched weight into confidence. name -> multiplier.
  var MODIFIERS = {
    'so': 1.3, 'really': 1.3, 'very': 1.3, 'way': 1.35, 'much': 1.2, 'god': 1.3,
    'fucking': 1.4, 'damn': 1.25, 'more': 1.15, 'even': 1.15,
    'a little': 0.7, 'little': 0.75, 'barely': 0.6, 'slightly': 0.7, 'kinda': 0.8, 'sorta': 0.8, 'bit': 0.8
  };

  return {
    lang: 'en',            // reserved i18n hook — English tables live under `en`
    en: {
      categories: categories,
      NEGATORS: NEGATORS,
      MODIFIERS: MODIFIERS
    },
    // convenience top-level aliases (engine reads these; other langs would nest under their code)
    categories: categories,
    NEGATORS: NEGATORS,
    MODIFIERS: MODIFIERS
  };
});
