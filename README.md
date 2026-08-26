# memory-cube

A multi-faceted memory compartment system with advanced privacy for [Claude Code](https://claude.com/claude-code)  — a zero-dependency drop-in that upgrades the flat auto-memory directory into a **hypercube recall engine** with **hard privacy compartments** and a **user-tunable personality**, without touching a single line of the harness, and app updates cannot wash it out.

## What it adds

**1. Hypercube recall** — `recall.mjs` reads the one-fact-per-file markdown corpus Claude Code already writes and
scores it on three composed axes: semantic (IDF-weighted cosine — no embeddings or models required), provenance
(firsthand beats told beats inferred), and valid-time (as-of queries: *"what did we believe last month?"*). Every
query runs a **boundary filter first**: tombstoned ("forgotten") memories, sealed compartments without a grant, and
memories outside the time view are removed *before* any relevance is computed — a high similarity can never reach
past a boundary, because boundaries are hard predicates, not weights. Every hit is explainable per-axis.

```bash
node recall.mjs query "which editor does the parser use" --k 5 --explain
node recall.mjs query "..." --as-of 2026-02-01          # time travel
node recall.mjs forget some-memory-slug                  # persisted tombstone; unforget reverses
```

**2. Compartments — routing, not moderation.** `compartments.json` is a user-editable registry (shipped:
intimate, medical, finances, vent). A dependency-free lexical classifier routes sensitive inputs into per-compartment
sealed memory files that are never indexed on the always-loaded surface and are unreachable to recall without an
explicit `--scope` grant. Nothing is blocked or rewritten — content is *compartmentalized*, so it only ever enters
model context in the situation it was meant for. Precedence: explicit prefix tag (`vent: ...`) > stored user answer
> strong phrase > ambiguous word (which pre-fires a dumb "did you mean...?" chip in the console — no model call) >
public. Adding a compartment is one JSON entry, zero code.

**3. Persona as memory, not instructions.** Character-sheet instructions wash out — chat context out-votes them.
The console compiles five temperament dials (+ archetype presets, traits, hard lines) into a *feedback-type memory
file* phrased as observed fact with a Why and a How-to-apply, which rides the recall surface the assistant actually
follows. Neutral dials are exactly inert: no behavior change until you move something.

**4. A console to drive it.** `node serve.mjs` → http://127.0.0.1:48972 — dial sliders with live tone-steer
preview, compiled-memory preview (public + sealed), install button, per-compartment grant checkboxes on a live
recall panel with per-axis score bars, and Forget/Unforget.

**5. A skill wrapper.** `skills/cube-recall/SKILL.md` teaches Claude Code to run recall *before* answering
memory-shaped questions (past state, pivots, contradictions) and embeds the scope-grant rule.

## Quickstart

Requires Node 18+. No npm install — there are zero dependencies.

```bash
git clone <this repo> && cd memory-cube
node selftest.mjs                 # self-contained: builds a fixture corpus, 14 assertions, ALL PASS expected
set CLAUDE_MEMORY_DIR=C:\Users\you\.claude\projects\<project-slug>\memory   # or export on unix
node recall.mjs query "anything you remember"
node serve.mjs                    # persona console on 127.0.0.1:48972
```

To install the compiled persona into your real memory: use the console's **Install** button (or
`node compile-persona.mjs install`). It writes `persona-claude.md` (+ sealed compartment files, never indexed) and
upserts one line in `MEMORY.md`. Fully reversible: delete the files and the line.

## Memory file format

Standard Claude Code auto-memory files work as-is (frontmatter `name`/`description` + body). Optional extra
frontmatter unlocks the sharper axes:

```markdown
---
name: some-memory-slug
description: "One-line summary — this is the scoring surface, keep it good"
metadata:
  type: project
  source: firsthand | told | inferred
  validFrom: 2026-02-01T00:00:00Z
  validTo:   2026-06-01T00:00:00Z    # omit = still current
  scope: sealed-medical              # omit = public
---
```

Unstamped legacy files get safe defaults (firsthand, valid-from file date, public).

## Security model

- **Boundary-first**: tombstones, forget-floors, scope isolation, and valid-time run as hard predicates over the
  point-set before any scoring. `filter()` returns `removed: [{id, reason}]` — an auditable record of what was
  withheld and why.
- **Sealed compartments** never appear in the always-loaded index; the public persona file carries only a
  generated-neutral pointer (counts + load condition, never user text). Limits ("hard lines") travel with the
  compartment they govern, so they are loaded exactly when the content they constrain is.
- **No model calls anywhere** in routing or recall — classification is lexical and deterministic, so sensitive
  content never transits a model to be sorted.
- Forgetting is a persisted tombstone, not a delete: it survives restarts and cannot be out-scored, and the
  original file remains on disk under your control.

## Layout

```
engine/            pure engine modules (recall boundary, cube recall, temperament dials, LexCore classifier)
recall.mjs         corpus loader + query/forget CLI + library
compartments.json  user-editable compartment registry
compartments.mjs   registry loader + router (prefix > override > strong > ambiguous-ask > public)
compile-persona.mjs  dials/traits -> memory-shaped persona files (public + sealed per compartment)
serve.mjs          no-dependency local server for the console
console.html       the persona + recall console UI
selftest.mjs       self-contained test suite (fixture corpus in a temp dir)
skills/cube-recall/  Claude Code skill wrapper
```

State lives in `state/` (persona.json, boundary.json) and previews in `out/` — both git-ignored.

## Known limits

- The semantic axis is IDF keyword cosine over slug + description — deliberately model-free. An `embed()` function
  can be injected into `makeCubeRecall` for true embedding similarity.
- Compartment lexicons are English seed lists; tune them to your vocabulary (that is what the registry is for).
- Ambiguous single words route to the *most restrictive* candidate until you answer the console's one-time
  "did you mean...?" prompt — conservative by design.

## License

MIT — see [LICENSE](LICENSE).
