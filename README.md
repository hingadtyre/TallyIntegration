# Stockbridge · Tally inventory integration

A local Windows dashboard for reviewing Tally stock and its mapped marketplace listings. The approved product design is in [architecture.md](docs/design/architecture.md).

This is the development project, not the customer's Tally machine. Use sample data here. Follow the [plain-language customer setup guide](docs/customer-setup.md) for the current read-only pilot; a shorter guide is also built into **Connections**. HingadTyre remains the first customer's context, while new installations use a neutral disconnected seller label.

**The complete first-customer synchronization release is not ready.** The [release-readiness audit](docs/release-readiness.md) separates missing application workflows, provider prerequisites and customer-machine verification.

## Current milestone

The first local foundation is implemented. It includes company-separated stock views, parent/child listing rows, search/brand/pack filters, selected or filtered bulk proposals, saved manual drafts, stale-review protection, Pause state, activity/diagnostic views, editable polling settings and verified manual SQLite backups.

**Marketplace publishing is disabled in both live and sample modes.** Saving a quantity changes only a draft. The server rejects `/api/publish`; no Flipkart stock-write adapter is installed. The active allowance and hold policies cannot be changed by an unsent draft.

The Tally adapter performs read-only XML exports. It requires stable company/item identifiers and validates the returned company context. Real installation compatibility, current-period balances and stock locations still need validation with Tally running. Unsupported quantities stay unknown; a failed read retains prior observations. See [the integration checklist](docs/integration/tally-validation.md).

HINGADTYRES is recorded only as the seller name observed in the browser. It is **not an authenticated API connection**. The app stores no Flipkart credentials yet.

## Packaged Windows pilot

The pilot package bundles Node.js 24, the built application, runtime dependencies and an offline HTML guide. Customers extract the ZIP and use **Start Stockbridge.cmd**, **Stop Stockbridge.cmd**, **Stockbridge Status.cmd** and **Open Data Folder.cmd**. They do not install development tools or build the application. The packaged live workspace lives under `%LOCALAPPDATA%\Stockbridge\Pilot\data`, independently of the extracted application files.

This is a portable, read-only pilot. It starts manually after Windows login; a signed installer, automatic startup/crash restart, controlled upgrades and full production recovery remain release work. See [packaging instructions for the provider](CONTRIBUTING.md#build-the-windows-pilot-package) and the [customer guide](docs/customer-setup.md).

For the provider, `npm run package:pilot` verifies/builds a new ZIP and `npm run test:pilot -- '<absolute ZIP path>'` checks that extracted artifact with an isolated local Tally simulation. These are development/release commands; customers use the supplied launch files.

## Run on this computer

Use Node.js 24 and the npm scripts in [package.json](package.json). Dependencies are pinned in `package-lock.json`; on a fresh checkout, install them with `npm ci` before building.

PowerShell, from this repository:

```powershell
npm run build
npm run demo
```

After the build succeeds, start Demo and open `http://127.0.0.1:4311` for clearly marked sample data. Stop with Ctrl+C in its terminal; closing the browser does not stop the backend. The sample database is `.data/demo.sqlite` and never reads Tally or calls a marketplace.

For the real workspace on the customer's Tally computer:

```powershell
npm start
```

Open `http://127.0.0.1:4310`, enable Tally's local HTTP server, load the intended company, and use **Refresh Tally**. The initial live database is empty. All companies returned by the verified read are kept separate. The first connector reports company-wide stock; publication must remain unavailable until location-specific mapping is implemented and checked.

The run commands use the existing build; they do not rebuild changed source. See [the development workflow](CONTRIBUTING.md#build-and-reload-behavior) for rebuilding and frontend development with automatic reload. The optional Windows launcher, [scripts/app.ps1](scripts/app.ps1), calls the same npm scripts while selecting a project-local Node runtime when available. Prefer npm directly when Node.js 24 is already selected.

## Verify

```powershell
npm run verify
```

This checks formatting, lint, TypeScript, tests and the production build. The same checks are configured in GitHub Actions. Use `npm run format` to apply formatting before verification. See [CONTRIBUTING](CONTRIBUTING.md) for the developer walkthrough, module map and sample development workflow.

Tests mirror their source modules under `tests/`. Use `npm test` for all tests, or pass a source test file/folder such as `npm test -- tests/client`. See [test organization and scope](CONTRIBUTING.md#test-organization-and-scope) for the mapping convention and what these tests establish.

Tests exercise real loopback HTTP transport with Tally-shaped fixtures, stock-policy examples, company boundaries, persisted drafts, stale reviews, settings, backups and rejection of publishing. They also cover failed dashboard actions, serialized polling, diagnostic error details and database upgrades. Fixture success is not proof of live Tally/Flipkart compatibility. Postman CLI was unavailable; transport tests use Node's local HTTP server. Public API discovery was checked through Orbit and official documentation, but no seller API token was available.

## Structure

- `src/domain`: pure pack arithmetic, named Flipkart tyre rule and separately tested allowance-consumption helper.
- `src/adapters`: read-only Tally XML transport and validation.
- `src/server`: local HTTP API and inventory commands, with separate stock refresh, polling, settings, backup and diagnostics modules.
- `src/server/storage`: SQLite schema, record conversion, validation and migrations.
- `src/client`: React dashboard with separate screens and focused inventory components; never reads credentials or the database directly.
- `src/desktop`: packaged Windows start/status/stop orchestration; verifies the responding instance before sending a private stop token.
- `src/shared`: API contracts.

SQLite schema version 2 stores companies, seller accounts, stock items, listings, proposals and activity as separate records. The API assembles a snapshot for the dashboard; database updates remain transactional and write only changed records. Existing version-1 databases are validated and backed up under `.data/migration-backups` before conversion. Invalid or newer databases are rejected without conversion.

This is not the final order/job ledger. Before publishing is enabled, introduce durable publication attempts, order receipts and activation generations with transactional updates and recovery checks.

## Data and operational limits

The runtime enforces one owner per workspace before opening SQLite, using an operating-system-held named pipe on Windows (an abstract socket on Linux for development/tests). Ownership releases on process exit. Application assets resolve from the application location, independently of the current working directory. `STOCKBRIDGE_DATA_DIR` selects an absolute local data folder; source checkouts default to their own `.data` directory. Network/device paths are rejected.

The backend continues while the browser is closed. The packaged Start command runs it without a persistent terminal; use Stop to shut it down cleanly. Source-checkout `npm start` remains a foreground process stopped with Ctrl+C. Shutdown drains an active Tally operation before closing SQLite. Windows automatic startup/service packaging is still pending.

Tally polling defaults to 30 seconds, never overlaps, and backs off after failures. Changes apply to future polls without restart. Marketplace/catalog intervals are saved preferences; those connectors are not running yet. Refresh does not write to Tally. Live accounts and sample records never share a database.

**Back up now** creates a consistent SQLite copy, runs an integrity check and writes a manifest. Changing the folder checks write access and affects future copies. A [technician-assisted offline pilot restore](CONTRIBUTING.md#restore-a-pilot-backup-support-only) validates a preview/hash, takes a safety copy, preserves local settings and restores under exclusive workspace ownership. Restored observations require fresh reads and listings are paused. It is not the production order/policy reconciliation workflow and has no customer import UI. Automatic daily/weekly retention and production restore recovery remain unfinished; do not overwrite a running database manually.

Activity history is retained for 90 days. Diagnostics include request references and sanitized internal error causes/call sites, and rotate at 10 MB with one previous file. Configurable time-based retention and background-run correlation are pending. Logs omit source XML, credentials and customer order payloads. `.data`, `.tools`, `.cache`, `releases`, dependencies and build outputs are ignored by Git. The private runtime-control file is separate from SQLite backups and must not be shared in support bundles.

Remaining production work: authenticated Flipkart setup/import, per-listing pack and location verification, durable manual publishing/read-back, activation/order reconciliation, automatic publishing, safe zero-and-verify unlink, scheduled backups, production restore recovery and Windows service/installer lifecycle. The dashboard labels these as unavailable rather than simulating a successful external change. Follow the [release gates](docs/release-readiness.md) before describing the product as ready for synchronization.
