# claude-persona — hypercube memory + personality console for Claude Code

A DROP-IN, not a code patch: everything lives in this folder + the memory directory, so Claude Code updates cannot
wash it out. Reuses Rook engine modules VERBATIM (copied from `rook-mesh/src`): `cubeRecall.js`, `recallBoundary.js`,
`temperament.js`.

## /cube-recall skill
`%USERPROFILE%\.claude\skills\cube-recall\SKILL.md` (user-level) wraps the CLI for every Claude Code session:
auto-triggers on past-state / history / contradiction questions, cites memory ids, embeds the scope-grant rule
(sealed compartments only when the user explicitly opened that context). Built after the 2026-08-25 A/B test showed
index-only answers can confidently mis-blend (FY500/rook-core) while recall-grounded ones self-correct.

## Self-test
`node selftest.mjs` — 17 assertions covering engine load, corpus load, ranking sanity, tombstone persistence +
reversal, the 8-case routing matrix (incl. the "please"/affirm_yes and "uncomfortable"/distress regressions),
compile split integrity, sandboxed scope gates, and the temperament inert-at-neutral invariant. Exit 0 = ALL PASS.
Run after every Claude Code update — the drop-in claims update-proofness; this is the proof. Touches nothing real
except a reverted tombstone round-trip.

## Pieces
- `recall.mjs` — hypercube recall over `~\.claude\projects\D--Claude\memory\*.md`. Boundary-first (tombstones persist in
  `state/boundary.json`), then 3-axis scoring (semantic IDF-cosine over slug+description, provenance, valid-time).
  CLI: `node recall.mjs query "text" [--as-of DATE] [--k N] [--explain] | forget <id> | unforget <id> | forgotten`
- `compile-persona.mjs` — dials/traits/hard-lines -> a `feedback`-type memory file (persona-claude.md), phrased as
  observed fact + Why + How-to-apply. Steer-via-context: recalled memory out-votes a character-sheet instruction.
  `install` writes it into the real memory dir + upserts one MEMORY.md index line. Reversible: delete file + line.
- `serve.mjs` + `console.html` — the console UI on http://127.0.0.1:48972 (launch: `node serve.mjs`, or the
  persona-console entry in `.claude/launch.json`). Dial sliders + Rook archetypes, live tone-steer preview, compiled
  memory preview, Install button, and a live recall panel with per-axis explain bars + Forget/Unforget.

## Compartments — generalized routing (business or pleasure, or anything)
`compartments.json` is a user-editable registry; each entry = { id, label, scope, loadWhen, strong[], ambiguous[],
prefixes[], stockCategories[] }. Shipped: intimate (LexCore-backed), medical, finances, vent (prefix-only — "vent:" /
"rant:" tags, proving the non-lexicon rule type). `compartments.mjs` builds ONE merged classifier and routes with
precedence: explicit prefix > per-item override > strong phrase / allowlisted stock category > ambiguous ask (sealed
in first candidate until answered) > public. Each non-empty compartment compiles to its own
`persona-claude-<id>.md` with its registry scope, never indexed; empty ones are deleted. Recall grants per
compartment: CLI `--scope medical` / `--scope intimate,finances`, one checkbox per compartment in the console.
Adding a compartment = one JSON entry, zero code. GOTCHA fixed in review: stock categories are an explicit
allowlist, never a whole LexCore layer — "please" fires affirm_yes and would drag ordinary text into a sealed scope.

## NSFW input handling — routing, not moderation
LexCore (vendored `engine/lexcore.cjs` + lexicon, from rook-core/fy-bridge — keep in sync with the adapter original)
classifies every trait / hard line / voice note at compile time, extended with one `intimate_profile` category (the
stock lexicon reads session commands, not descriptive profile text). Routing keys on intimate layers L1-L3 ONLY —
L0 safety and L4 valence never route ("naming the uncomfortable finding" would false-positive as distress otherwise).
Nothing is blocked or rewritten: flagged items move to `persona-claude-intimate.md` with `scope: sealed-intimate`,
which is (a) NEVER indexed in MEMORY.md, (b) unreachable to recall without an explicit `--scope intimate` /
"intimate scope" checkbox grant (recallBoundary R1 hard predicate), and (c) auto-deleted on install when it empties.
The public profile keeps only a neutral one-line pointer. Intimate hard lines travel WITH the sealed scope so the
limits are always loaded exactly when the content they govern is.

Ambiguity is a three-tier pre-fire, no model call involved: STRONG terms ("dirty talk", "nsfw", phrase-level) route
silently; AMBIGUOUS single words ("explicit", "sex", "dominant", "climax"...) never route silently — the console
renders a dumb "did you mean X intimately?" chip per item, and the item sits SEALED (leak-safe default) until
answered. Answers persist as per-item `scopeOverrides` in persona.json, so a question is asked once, ever.

## Corpus-specific tuning (differs from engine defaults, reasons in-code)
- scoring surface = slug + description only (long jargon-dense bodies skew the IDF norm; description is the
  write-time-curated recall key)
- floor 0.04, weights semantic .82 / provenance .06 / time .12 (provenance near-uniform until the corpus is
  facet-backfilled with source:/validFrom: stamps)
