# ADR 0005: AGENTS.md is the canonical agent instruction file

Date: 2026-10-08. Status: accepted.

## Context

AGENTS.md is the cross-tool standard (Linux Foundation, read natively by
Codex, Cursor, Copilot, Windsurf, Devin, Aider, Zed, Amp). Claude Code reads
CLAUDE.md and supports `@file` imports.

## Decision

- `AGENTS.md` holds all agent-facing instructions.
- `CLAUDE.md` contains only `@AGENTS.md`.
- Keep AGENTS.md operational: commands, gates, gotchas. Narrative goes to
  `docs/`. Research shows README-style agent files raise token cost and
  slightly hurt agent performance; narrow directives help.

## Consequences

- One source of truth, no drift between tool-specific files.
- Any new gotcha discovered during development is added to AGENTS.md in the
  same change that discovered it.
