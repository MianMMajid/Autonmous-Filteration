# ADR 0002: Biome for lint and format instead of ESLint plus Prettier

Date: 2026-10-08. Status: accepted.

## Context

typescript-eslint's peer range is `typescript >=4.8.4 <6.1.0`; it cannot load
TypeScript 7. Running ESLint would require aliasing a second TypeScript 6
install solely for linting.

## Decision

Biome 2.5 as the single tool for linting, formatting, and import ordering. The
`project` domain is enabled for type-aware rules such as `noFloatingPromises`.

## Consequences

- One config file, one binary, fast enough to run on save and in CI.
- Rule coverage is narrower than the ESLint ecosystem. If a needed rule is
  missing, write a small test instead of adding ESLint.
- Revisit when TypeScript 7.1 ships its API and typescript-eslint supports it.
