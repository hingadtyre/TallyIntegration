# Stockbridge · Tally inventory integration

A local Windows dashboard for reviewing Tally stock and managing Flipkart seller listings. The approved product design is in [architecture.md](docs/design/architecture.md) and [marketplace listing management](docs/design/marketplace-listings.md).

This is the development project, not the customer's Tally machine. Use sample data here. Follow the [plain-language customer setup guide](docs/customer-setup.md); a shorter guide is also built into **Connections**. A new live **Marketplaces** page starts with **Add account**, without sample seller tiles.

**The complete first-customer synchronization release is not ready.** The [release-readiness audit](docs/release-readiness.md) separates missing application workflows, provider prerequisites and customer-machine verification.

## Current milestone

The first local foundation is implemented. It includes company-separated stock views, parent/child listing rows, search/brand/pack filters, selected or filtered bulk proposals, saved manual drafts, stale-review protection, Pause state, activity/diagnostic views, editable polling settings and verified manual SQLite backups.

**Marketplaces supports direct stock, MRP and selling-price edits with each editor's Apply action. In live mode Apply sends a real Flipkart request.** Accounts have independent credentials, seller binding, listing observations and outcomes. Refresh imports all five documented listing states and location stock; search and filters cover the complete last successful import. Tally setup is not required for this view. Settlement opens Seller Hub because a supported listing-settlement API has not been established.

Inventory proposals and automatic Tally-to-Flipkart publishing remain disabled: `/api/publish` is still rejected, and Inventory drafts do not change stock. Direct edits preserve holds and sales allowances. Positive stock under Limited sales is blocked in live mode until order reconciliation exists or the seller explicitly returns that destination to Auto policy. Changing policy does not itself publish; Pause is retained.

The Tally adapter performs read-only XML exports. It requires stable company/item identifiers and validates the returned company context. Real installation compatibility, current-period balances and stock locations still need validation with Tally running. Unsupported quantities stay unknown; a failed read retains prior observations. See [the integration checklist](docs/integration/tally-validation.md).

In **Marketplaces > Add account**, choose Flipkart and enter a name and the seller-owned Self Access Application ID and Secret. **Save without verification** protects them locally without contacting Flipkart; **Verify and save** checks token access first. Each added account has its own Windows-protected credential folder outside SQLite/backups. Previously saved primary credentials are adopted without moving the file. Token requests go directly to Flipkart; this route needs no hosted Stockbridge authentication service. See [the self-access decision](docs/adr/0004-seller-owned-flipkart-self-access.md) and [setup steps](docs/customer-setup.md#optional-verify-seller-owned-flipkart-api-access).

**API credentials verified** means token access only. A successful complete listing refresh must bind the actual seller before edits or result checks, again after a process restart or credential operation. Credentials for a different seller cannot replace an existing binding; add that seller separately. Empty accounts cannot establish a new seller identity. Historical evidence: **Stockbridge Local** was submitted in HINGADTYRES on 2026-11-08 and displayed **Pending** then. Its current approval state, real token access and live listing/write contracts have not been verified. HingadTyre's confirmed internal own-account use matches the documented Self Access category; this does not establish independent-seller distribution eligibility.

## Packaged Windows pilot

The pilot package bundles Node.js 24, the built application, runtime dependencies and an offline HTML guide. Customers extract the ZIP and use **Start Stockbridge.cmd**, **Stop Stockbridge.cmd**, **Stockbridge Status.cmd** and **Open Data Folder.cmd**. They do not install development tools or build the application. The packaged live workspace lives under `%LOCALAPPDATA%\Stockbridge\Pilot\data`, independently of the extracted application files.

This is a portable pilot with read-only Tally access and explicit marketplace edits. It starts manually after Windows login; a signed installer, automatic startup/crash restart, controlled upgrades and full production recovery remain release work. Customer distribution requires a verified package built from the intended source; see the dated artifact evidence in [release readiness](docs/release-readiness.md), [packaging instructions for the provider](CONTRIBUTING.md#build-the-windows-pilot-package) and the [customer guide](docs/customer-setup.md).

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

Open `http://127.0.0.1:4310`, enable Tally's local HTTP server, load the intended company, and use **Refresh Tally**. The initial live database is empty. All companies returned by the verified read are kept separate. The first connector reports company-wide stock; Inventory publishing remains unavailable until source-location mapping and the remaining synchronization workflows are implemented and checked. **Marketplaces** can be used independently of Tally.

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
- `src/adapters`: read-only Tally XML transport, Flipkart self-access tokens and bounded listing search/detail/stock/price transport.
- `src/server`: local HTTP API, inventory commands and separate account/catalog/publication modules, plus stock refresh, polling, settings, backups, protected credentials and diagnostics.
- `src/server/storage`: SQLite schema, record conversion, validation and migrations.
- `src/client`: React dashboard with separate screens and focused inventory components. The credential form sends entered values to the local backend; it never reads saved secrets or accesses the database directly.
- `src/desktop`: packaged Windows start/status/stop orchestration; verifies the responding instance before sending a private stop token.
- `src/shared`: API contracts.

SQLite schema version 3 adds marketplace accounts, listing observations and durable direct-update attempts to the existing inventory records. Database updates remain transactional. Supported version-1 and version-2 databases are validated and backed up under the workspace's `migration-backups` folder before upgrade. Invalid or newer databases are rejected without conversion.

Direct Apply persists the attempt, checks fresh values before writing and verifies the result with another read. Unconfirmed outcomes block another edit for that listing until resolved through **Check result**. Restarted in-flight attempts become uncertain and are never automatically resent. This is not the future order-receipt ledger, allowance activation or automatic Tally publication queue.

## Data and operational limits

The runtime enforces one owner per workspace before opening SQLite, using an operating-system-held named pipe on Windows (an abstract socket on Linux for development/tests). Ownership releases on process exit. Application assets resolve from the application location, independently of the current working directory. `STOCKBRIDGE_DATA_DIR` selects an absolute local data folder; source checkouts default to their own `.data` directory. Network/device paths are rejected.

The backend continues while the browser is closed. The packaged Start command runs it without a persistent terminal; use Stop to shut it down cleanly. Source-checkout `npm start` remains a foreground process stopped with Ctrl+C. Shutdown drains an active Tally operation before closing SQLite. Windows automatic startup/service packaging is still pending.

Tally polling defaults to 30 seconds, never overlaps, and backs off after failures. Changes apply to future polls without restart. Marketplace/catalog intervals remain saved preferences; listing import uses explicit **Refresh listings**, not a background schedule. Refresh does not write to Tally. Live accounts and sample records never share a database.

Self Access supports separate credential sets per added account. Demo mode uses clearly marked sample edits and never contacts Flipkart. Account credential checks and local disconnect affect only that account; disconnect does not delete its Flipkart application or change stock. Tokens remain memory-only and are renewed from returned expiry information. Credentials stay out of Git, logs, packages and SQLite backups; a new computer/Windows login needs its own setup.

**Back up now** creates a consistent SQLite copy, runs an integrity check and writes a manifest. Changing the folder checks write access and affects future copies. A [technician-assisted offline pilot restore](CONTRIBUTING.md#restore-a-pilot-backup-support-only) validates a preview/hash, takes a safety copy, preserves local settings and restores under exclusive workspace ownership. It retains any existing protected credentials in the same workspace; the backup does not supply them. Tokens are memory-only; check the intended account connection and refresh its listings after restarting. A moved/new workspace or another Windows user needs credential setup again. Restored observations require fresh reads and Inventory listings are paused. Marketplace seller bindings remain, account/listing freshness is cleared, and unfinished attempts become uncertain without automatic replay. Refresh each account before Apply or Check result. It is not the production order/policy reconciliation workflow and has no customer import UI. Automatic daily/weekly retention and production restore recovery remain unfinished; do not overwrite a running database manually.

Activity history is retained for 90 days. Diagnostics include request references and sanitized internal error causes/call sites, and rotate at 10 MB with one previous file. Configurable time-based retention and background-run correlation are pending. Logs omit source XML, credentials and customer order payloads. `.data`, `.tools`, `.cache`, `releases`, dependencies and build outputs are ignored by Git. The private runtime-control file is separate from SQLite backups and must not be shared in support bundles.

Remaining production work: live account/API contract verification, per-listing pack and Tally source-location mapping, Inventory publication, activation/order reconciliation, automatic publishing, safe zero-and-verify unlink, scheduled backups, production restore recovery and Windows service/installer lifecycle. Local fixtures validate account import and direct Apply behavior; no real Flipkart import or write has been verified. Follow the [release gates](docs/release-readiness.md) before describing the product as ready for synchronization.
