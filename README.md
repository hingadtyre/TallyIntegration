# Stockbridge · Tally inventory integration

A local Windows dashboard for reviewing Tally stock and its mapped marketplace listings. The approved product design is in [architecture.md](docs/design/architecture.md).

This is the development project, not the customer's Tally machine. Use sample data here. Follow the [HingadTyre customer setup guide](docs/customer-setup.md) when installing on the customer's computer; a shorter guide is also built into **Connections**. The existing HINGADTYRES Flipkart observations remain the first customer's setup context.

## Current milestone

The first local foundation is implemented. It includes company-separated stock views, parent/child listing rows, search/brand/pack filters, selected or filtered bulk proposals, saved manual drafts, stale-review protection, Pause state, activity/diagnostic views, editable polling settings and verified manual SQLite backups.

**Marketplace publishing is disabled in both live and sample modes.** Saving a quantity changes only a draft. The server rejects `/api/publish`; no Flipkart stock-write adapter is installed. The active allowance and hold policies cannot be changed by an unsent draft.

The Tally adapter performs read-only XML exports. It requires stable company/item identifiers and validates the returned company context. Real installation compatibility, current-period balances and stock locations still need validation with Tally running. Unsupported quantities stay unknown; a failed read retains prior observations. See [the integration checklist](docs/integration/tally-validation.md).

HINGADTYRES is recorded only as the seller name observed in the browser. It is **not an authenticated API connection**. The app stores no Flipkart credentials yet.

## Run on this computer

The project-local Node.js 24 runtime is under `.tools`; it does not replace the machine's Node installation. Dependencies are pinned in `package-lock.json`.

PowerShell, from this repository:

```powershell
.\scripts\app.ps1 -Mode Build
.\scripts\app.ps1 -Mode Demo
```

Open `http://127.0.0.1:4311` for clearly marked sample data. Stop with Ctrl+C. The sample database is `.data/demo.sqlite` and never reads Tally or calls a marketplace.

For the real workspace on the customer's Tally computer:

```powershell
.\scripts\app.ps1 -Mode Live
```

Open `http://127.0.0.1:4310`, enable Tally's local HTTP server, load the intended company, and use **Refresh Tally**. The initial live database is empty. All companies returned by the verified read are kept separate. The first connector reports company-wide stock; publication must remain unavailable until location-specific mapping is implemented and checked.

On a fresh checkout, install official Node.js 24 LTS, run `npm ci`, then the commands above. This machine's corporate mirror/proxy was unavailable during setup, so dependencies were downloaded from the public npm registry using a temporary project-local configuration. No global npm configuration was changed. Configure your own session's network access as required.

## Verify

```powershell
.\scripts\app.ps1 -Mode Verify
```

This checks formatting, lint, TypeScript, tests and the production build. The same checks are configured in GitHub Actions. Use `-Mode Format` to apply formatting before verification. See [CONTRIBUTING](CONTRIBUTING.md) for the developer walkthrough, module map and sample development workflow.

Tests exercise real loopback HTTP transport with Tally-shaped fixtures, stock-policy examples, company boundaries, persisted drafts, stale reviews, settings, backups and rejection of publishing. They also cover failed dashboard actions, serialized polling, diagnostic error details and database upgrades. Fixture success is not proof of live Tally/Flipkart compatibility. Postman CLI was unavailable; transport tests use Node's local HTTP server. Public API discovery was checked through Orbit and official documentation, but no seller API token was available.

## Structure

- `src/domain`: pure pack arithmetic, named Flipkart tyre rule and separately tested allowance-consumption helper.
- `src/adapters`: read-only Tally XML transport and validation.
- `src/server`: local HTTP API and inventory commands, with separate stock refresh, polling, settings, backup and diagnostics modules.
- `src/server/storage`: SQLite schema, record conversion, validation and migrations.
- `src/client`: React dashboard with separate screens and focused inventory components; never reads credentials or the database directly.
- `src/shared`: API contracts.

SQLite schema version 2 stores companies, seller accounts, stock items, listings, proposals and activity as separate records. The API assembles a snapshot for the dashboard; database updates remain transactional and write only changed records. Existing version-1 databases are validated and backed up under `.data/migration-backups` before conversion. Invalid or newer databases are rejected without conversion.

This is not the final order/job ledger. Before publishing is enabled, introduce durable publication attempts, order receipts and activation generations with transactional updates and recovery checks.

## Data and operational limits

Use one running process per database. The backend continues while the browser is closed; closing its terminal stops it. Windows automatic startup/service packaging is still pending.

Tally polling defaults to 30 seconds, never overlaps, and backs off after failures. Changes apply to future polls without restart. Marketplace/catalog intervals are saved preferences; those connectors are not running yet. Refresh does not write to Tally. Live accounts and sample records never share a database.

**Back up now** creates a consistent SQLite copy, runs an integrity check and writes a manifest. Changing the folder checks write access and affects future copies. Automatic daily/weekly retention and restore/import are not implemented yet; do not replace a live database manually and assume pending state is safe to resume. The approved recovery workflow must be completed before production publishing.

Activity history is retained for 90 days. Diagnostics include request references and sanitized internal error causes/call sites, and rotate at 10 MB with one previous file. Configurable time-based retention and background-run correlation are pending. Logs omit source XML, credentials and customer order payloads. `.data`, `.tools`, `.cache`, dependencies and build outputs are ignored by Git.

Remaining delivery work: authenticated Flipkart setup/import, per-listing pack and location verification, durable manual publishing/read-back, activation/order reconciliation, automatic publishing, safe zero-and-verify unlink, scheduled backups, restore recovery and Windows packaging. The dashboard labels these as unavailable rather than simulating a successful external change.
