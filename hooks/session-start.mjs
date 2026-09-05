#!/usr/bin/env node
// SessionStart hook — prints the active persona dial-set + compartment population status as context.
// Makes the engine's state VISIBLE at session open (previously you had to ask Claude to discover it),
// and guarantees the dials are present even if MEMORY.md gets trimmed. Reads only; never mutates.
// Wired from D:\Claude\.claude\settings.json. Part of the claude-persona drop-in (update-proof).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function out(s) { process.stdout.write(s + "\n"); }

try {
  // read stdin (hook payload) but we don't need any field beyond knowing it fired
  // (SessionStart payload: { session_id, source: startup|resume|clear, ... })

  const personaPath = join(ROOT, "state", "persona.json");
  const lines = [];

  if (existsSync(personaPath)) {
    const p = JSON.parse(readFileSync(personaPath, "utf8"));
    const d = p.dials || {};
    const dial = (k) => (typeof d[k] === "number" ? (d[k] >= 0 ? "+" : "") + d[k].toFixed(1) : "?");
    lines.push(`[persona-engine] active dial-set — preset "${p.preset || "custom"}"`);
    lines.push(
      `  warmth ${dial("warmth")}  energy ${dial("energy")}  playfulness ${dial("playfulness")}  ` +
      `forwardness ${dial("forwardness")}  steadiness ${dial("steadiness")}`
    );
    if (p.voiceNotes) lines.push(`  voice: ${p.voiceNotes}`);
    // Counts only — trait / hard-line bodies are free-text and may hold sealed-eligible content.
    // This banner is injected as context every session and travels in a public plugin; never echo the bodies here.
    if (Array.isArray(p.traits) && p.traits.length) lines.push(`  traits: ${p.traits.length} active (bodies not shown)`);
    if (Array.isArray(p.hardLines) && p.hardLines.length) lines.push(`  hard lines: ${p.hardLines.length} active (bodies not shown)`);
  } else {
    lines.push(`[persona-engine] no state/persona.json found — running stock.`);
  }

  // Compartment population status: scan the REAL memory dir for sealed compartment files.
  const memDir = process.env.CLAUDE_MEMORY_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", "D--Claude", "memory");
  let populated = [];
  try {
    if (existsSync(memDir)) {
      populated = readdirSync(memDir)
        .map((f) => (f.match(/^persona-claude-(.+)\.md$/) || [])[1])
        .filter(Boolean);
    }
  } catch {}

  if (populated.length) {
    lines.push(`[persona-engine] privacy compartments POPULATED (sealed, recall needs explicit --scope): ${populated.join(", ")}`);
  } else {
    lines.push(`[persona-engine] privacy compartments: none populated (routing armed, sealed store empty).`);
  }

  out(lines.join("\n"));
} catch {
  // Never break session start. Silent, exit 0.
}
process.exit(0);
