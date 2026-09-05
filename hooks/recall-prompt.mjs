#!/usr/bin/env node
// UserPromptSubmit hook — auto-recall. Turns memory recall from "Claude remembered to run the skill"
// into "grounded memory is always present, deterministically." Reads the user's prompt from stdin,
// routes it through the compartment classifier for a LEAK-SAFE scope gate, runs hypercube recall,
// and prints the top hits as context injected before Claude answers. Reads only; never mutates.
//
// Scope gate (privacy): analyze(prompt) -> {route, ask}.
//   - strong/prefix match (ask:false) => the prompt EXPLICITLY opened that scope => grant --scope.
//   - ambiguous match  (ask:true)     => DO NOT grant, and stay silent about it (never reveal a
//     sealed compartment exists from an ambiguous word). Leak-safe default.
//   - no match                        => public recall only.
//
// Gating (noise/token control): skip empty prompts, slash-commands, and very short prompts; only emit
// hits at or above REL_FLOOR. On any error: silent, exit 0 (must never block a prompt).
// Wired from D:\Claude\.claude\settings.json. Part of the claude-persona drop-in (update-proof).

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// Windows ESM: dynamic import() of an absolute path must be a file:// URL, not a bare "D:\..." path
// (else ERR_UNSUPPORTED_ESM_URL_SCHEME). pathToFileURL makes it portable across OSes.
const mod = (f) => import(pathToFileURL(join(ROOT, f)).href);

const K = 4;              // hits to consider
const REL_FLOOR = 0.12;   // only inject hits at/above this score (drops trivial/unrelated turns)
const MIN_WORDS = 3;      // skip terse prompts ("yes", "ok, go")

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      setTimeout(finish, 2000); // don't hang if stdin never closes
    } catch { finish(); }
  });
}

(async () => {
  try {
    const raw = await readStdin();
    let prompt = "";
    try { prompt = String(JSON.parse(raw || "{}").prompt || ""); } catch { prompt = String(raw || ""); }
    prompt = prompt.trim();

    // gate: empty, slash-command, or too short
    if (!prompt || prompt.startsWith("/") || prompt.split(/\s+/).length < MIN_WORDS) return;

    // scope gate via compartment classifier
    let allowScopeIds = [];
    try {
      const { makeRouter } = await mod("compartments.mjs");
      const { analyze } = makeRouter();
      const a = analyze(prompt);
      if (a.route && !a.ask) allowScopeIds = [a.route]; // explicit open only; ambiguous stays sealed & silent
    } catch {}

    const { runQuery } = await mod("recall.mjs");
    const { scopeFor } = await mod("compartments.mjs");
    const allowScopes = allowScopeIds.map((id) => scopeFor(id)).filter(Boolean);

    const hits = (await runQuery(prompt, { k: K, allowScopes }))
      .filter((h) => (h._score || 0) >= REL_FLOOR);

    if (!hits.length) return;

    const lines = ["[persona-recall] grounded memory for this prompt (cite ids; Read the file before load-bearing claims):"];
    if (allowScopeIds.length) lines.push(`  scope granted: ${allowScopeIds.join(", ")} (prompt explicitly opened it)`);
    for (const h of hits) {
      const when = new Date(h.validFrom).toISOString().slice(0, 10);
      lines.push(`  ${h._score.toFixed(3)} [${h.id}] (${h.provenance}, ${when}) ${String(h.description).slice(0, 140)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } catch {
    // never block a prompt
  }
  process.exit(0);
})();
