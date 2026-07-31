# @didacta/module-package-spec

Versioned contract for the layout of a Didacta module ZIP. Single source of truth shared by:

- The backend validator (`apps/api/src/marketplace/*.service.ts`)
- The official packager (`didacta-modules-skill/scripts/package-module.mjs`)
- Any third-party packager or auditing tool

Zero runtime dependencies (only Node builtins). Pure functions, fully testable, multi-runtime.

## Why this exists

Before this package, the contract for "what a valid module ZIP looks like" lived in three different places:

- Comments in backend services (`module-migration.service.ts`)
- Hardcoded logic in the official packager
- Scattered notes outside the repo

The result: divergence between the packager and the validator. Third-party developers using `prisma migrate dev` (the standard Prisma flow) generated ZIPs the validator silently rejected at upload time. This package eliminates that asymmetry by being the only implementation either side imports.

See **ADR-013 — Contrato del paquete de módulo** (internal decision log) for the full rationale.

## Public API

```typescript
import {
  validatePackageLayout,
  normalizeMigrations,
  SPEC_VERSION,
  type PackageEntries,
  type ValidationResult,
  type NormalizationResult,
  type SourceFile,
} from '@didacta/module-package-spec';
```

### `validatePackageLayout(entries: PackageEntries): ValidationResult`

Validates that a set of ZIP entries (`Map<path, Buffer>`) conforms to the spec. Returns `{ valid, errors, warnings }`.

The validator does **not** parse ZIPs itself — it accepts already-extracted entries. This keeps the package zero-deps and lets each caller use whatever ZIP parser it prefers (`adm-zip`, `yauzl`, custom).

```typescript
import AdmZip from 'adm-zip';
import { validatePackageLayout } from '@didacta/module-package-spec';

const zip = new AdmZip(packageBuffer);
const entries = new Map<string, Buffer>();
for (const e of zip.getEntries()) {
  if (!e.isDirectory) entries.set(e.entryName, e.getData());
}

const result = validatePackageLayout(entries);
if (!result.valid) {
  for (const err of result.errors) console.error(`[${err.code}] ${err.message}`);
}
```

### `normalizeMigrations(sources: SourceFile[]): NormalizationResult`

Translates a developer's filesystem layout into the canonical ZIP layout. Specifically:

- `prisma/migrations/<ts>_<name>/migration.sql` → `prisma/migrations/<ts>_<name>.sql` (Prisma native → flat)
- Strips `migration_lock.toml`, `README.md`, hidden files
- Detects collisions after flattening
- Rejects unexpected subdirs and non-`.sql` files

```typescript
import { normalizeMigrations } from '@didacta/module-package-spec';

const sources = [
  { relativePath: 'prisma/migrations/20260503000000_init/migration.sql', content: buf },
  { relativePath: 'prisma/migrations/migration_lock.toml', content: buf2 },
];
const result = normalizeMigrations(sources);
// result.files: [{ zipPath: 'prisma/migrations/20260503000000_init.sql', content: buf }]
// result.stripped: ['prisma/migrations/migration_lock.toml']
// result.errors: []
```

## Spec rules (v1)

### Required files

A valid ZIP must contain (case-sensitive):

- `manifest.jwt` — JWS compact (ES256) with the manifest as payload
- `package.json` — minimal `{ name, version, main: "dist/index.js" }`
- `dist/index.js` — CommonJS bundle of the module backend

### `prisma/migrations/` rules

- Files must be **flat** (no subdirs). Prisma's native `<ts>_<name>/migration.sql` is rejected; the packager must flatten via `normalizeMigrations`.
- Only `.sql` extension allowed. `migration_lock.toml`, `README.md`, hidden files must be stripped before zipping.
- Filenames must match `/^[A-Za-z0-9_.-]+\.sql$/` — no spaces, no path separators.

### `dist/ui/` rules

- Bundles must be flat (no subdirs).
- Only `.js` extension allowed.
- One bundle per surface: `dist/ui/admin.js`, `dist/ui/formador.js`, etc.

### Path safety

- No path traversal (`..`)
- No backslashes (forward slashes only)
- No absolute paths or drive letters

### Size

- Total package size under **50 MB**.

## Error codes

The spec emits a strict subset of `MarketplaceErrorCode` from the backend:

- `PACKAGE_TOO_LARGE`
- `PACKAGE_INVALID_ZIP`
- `PACKAGE_MISSING_FILE`
- `MODULE_LINT_FAILED`

Errors that depend on parsing the manifest (signature, schema validation, core version compatibility, etc.) live in the backend's pipeline, after layout validation passes.

## Versioning

Strict SemVer. Major version = breaking change in the contract. The current version is **1.0.0**, exported as `SPEC_VERSION`.

## How third-party tools should consume this

When this package is published to npm:

```bash
npm install @didacta/module-package-spec
```

Until then (Phase 1, internal): consumed via pnpm workspace inside `didacta-community`. The `didacta-modules-skill` repo vendors a frozen copy with a SHA-256 hash check in CI to prevent drift.

## License

UNLICENSED (private). Will move to SUL v1.0 along with the rest of the Didacta Community codebase before public npm publish.
