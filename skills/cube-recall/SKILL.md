---
name: cube-recall
description: Hypercube recall over the persistent memory corpus (memory-cube drop-in). Use BEFORE answering from the MEMORY.md index alone whenever the question involves past state ("what did we believe/have before X"), when or why something changed, project history across a pivot or retirement, contradictions between memories, or which memory is fresher/firsthand. Also invoked directly as /cube-recall <query>.
---

# cube-recall — grounded memory recall

The MEMORY.md index is a map; this is the territory. Index one-liners can cause confident wrong blends of two
different rules; recalled memory bodies prevent that. When a question is memory-shaped, run recall FIRST, then
answer grounded in the hits.

Install: copy this folder to `~/.claude/skills/cube-recall/` and replace `<MEMORY_CUBE_PATH>` below with the
absolute path of your memory-cube checkout.

## Run

```bash
node <MEMORY_CUBE_PATH>/recall.mjs query "<query words>" --k 5 --explain
```

Flags:
- `--as-of 2026-07-01` — valid-time view: only memories formed by that date (answers "what did we believe then").
- `--provenance firsthand|told|inferred` — prefer a provenance.
- `--scope <id>[,<id>]` — grant sealed compartments (see compartments.json). NEVER pass a scope grant unless the
  user has explicitly opened that context in the conversation; a sealed compartment's content must not enter any
  other session's answer.

Forgetting (persisted tombstones — unreachable from every query until reversed):

```bash
node <MEMORY_CUBE_PATH>/recall.mjs forget <memory-id>
```

`unforget <id>` reverses; `forgotten` lists.

## Use the results

1. Ground the answer in the hit bodies, not just descriptions; cite memory ids like [some-memory-slug].
2. Top hits are ranked semantic-heavy with provenance/time tiebreaks; `--explain` shows per-axis contributions
   when the ranking itself is the question.
3. Hits carry a validFrom date — flag staleness when a hit is old and the topic moves fast.
4. After recall, still Read the full memory file for load-bearing answers; the scored body is a short excerpt.
5. If nothing returns, say so — the floor drops confident-nearest-noise on purpose; do not substitute a guess.

During memory consolidation passes, use queries per topic cluster to find duplicates and contradictions before
merging.
