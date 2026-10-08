# ADR 0003: Vendor SheetJS 0.20.3 as a tarball

Date: 2026-10-08. Status: accepted.

## Context

The SiteLedger Project Register is a legacy BIFF8 `.xls` file. ExcelJS and the
TypeScript-native XLSX parsers read only `.xlsx`. SheetJS is the one maintained
library that reads both. Its npm package is frozen at 0.18.5 with known
advisories; maintained releases are distributed from the vendor's CDN.

## Decision

Download `xlsx-0.20.3.tgz` from `https://cdn.sheetjs.com/xlsx-0.20.3/`, commit
it under `vendor/`, and depend on it via `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`.

SHA-256 of the committed tarball:
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`

## Consequences

- Installs are reproducible and offline-capable.
- Dependabot and `npm audit` do not see the package. Check the SheetJS
  changelog manually when bumping.
- The ESM build needs `set_fs` wired before reading from disk; the SiteLedger
  parser does this once at module load.
