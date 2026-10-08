# ADR 0001: Run TypeScript natively on Node 26, type-check with TypeScript 7

Date: 2026-10-08. Status: accepted.

## Context

Node 26 strips types natively and this is stable and on by default. TypeScript
7.0 is the current compiler (Go-native, roughly 10x faster) but ships without a
programmatic API until 7.1.

## Decision

- Execute `.ts` source directly with `node`. No bundler, no `tsx`, no build
  step for running.
- Use TypeScript 7.0.2 with `tsc --noEmit` as the type gate.
- Enable `erasableSyntaxOnly`, `verbatimModuleSyntax`, and explicit `.ts`
  import extensions so `tsc` rejects anything Node cannot execute.
- Keep `tsconfig.build.json` for an optional compiled `dist/`.

## Consequences

- No enums, no parameter properties, no decorators. Use `as const` objects and
  explicit fields.
- Tools that need the TypeScript API (typescript-eslint, ts-jest) are out. See
  ADR 0002.
- `types` must be listed explicitly (`["node"]`) and `rootDir` set, because
  TypeScript 7 changed both defaults.
