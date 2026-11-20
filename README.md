# Stockbridge · Tally inventory integration

A local Windows dashboard for reviewing Tally stock and managing Flipkart seller listings. The approved product design is in [architecture.md](docs/design/architecture.md) and [marketplace listing management](docs/design/marketplace-listings.md).

This is the development project, not the customer's Tally machine. Use sample data here. Follow the [plain-language customer setup guide](docs/customer-setup.md); a shorter guide is also built into **Connections**. A new live **Marketplaces** page starts with **Add account**, without sample seller tiles.

A fresh live workspace has no company or seller account in its selectors. Tally company names come from discovery; seller names appear after adding an account. Unused placeholder seller records from older versions are hidden without deleting saved names or history. Existing accounts with listings remain visible. Demo mode uses generic, clearly marked sample data.

**The complete first-customer synchronization release is not ready.** The [release-readiness audit](docs/release-readiness.md) separates missing application workflows, provider prerequisites and customer-machine verification.

## Current milestone

**Order matching** lets each seller select a Tally company, Flipkart account and sales ledger. Choose where the order ID, order-item ID or invoice number is recorded, or review bills manually. Select today, the last 7 days or the last 30 days, preview the results, then save the setup. An exact reference, matching stock item and quantity can identify a unique bill. A seller can confirm or release a manual match. Flipkart supplies the orders and Tally supplies posted sales evidence. A ledger entry alone cannot establish that a Flipkart order exists.

For automatic stock updates, confirm a starting date in **Order matching** after accounting for all earlier sales. Stockbridge checks all participating sellers, converts each unbilled Flipkart order into Tally units, and subtracts those units before calculating packs for each listing. If Tally shows six tyres and one is already sold on Flipkart, a single-tyre listing can publish five. Once the matching sale is billed and Tally shows five, five remain available. An incomplete check keeps a positive calculated update pending. The short, single-account preview helps identify bills. [Customer setup](docs/customer-setup.md) · [Flipkart coverage](docs/integration/flipkart-validation.md) · [Tally coverage](docs/integration/tally-validation.md)

The first local foundation is implemented. It includes company-separated stock views, parent/child listing rows, search/brand/pack filters, selected or filtered bulk proposals, saved manual drafts, stale-review protection, Pause state, activity/diagnostic views, editable polling settings and verified manual SQLite backups.

With coverage configured, **Inventory → Calculate** also prepares the adjusted quantity for review when automatic sync is off. Apply checks the available stock again. If a new order makes the reviewed quantity too high, calculate again to see the new amount.

The sidebar starts collapsed at every screen size. Use the arrow below the Stockbridge logo to expand or collapse it. Navigation icons remain available in the collapsed view. On narrow screens, navigation expands over the page and closes after selecting a screen. Toggling the sidebar preserves the current screen and its unsaved inputs.

**Marketplaces supports direct stock, MRP and selling-price edits with each editor's Apply action. In live mode Apply sends a real Flipkart request.** Accounts have independent credentials, seller binding, listing observations and outcomes. Refresh imports all five documented listing states and location stock; search and filters cover the complete last successful import. Tally setup is not required for this view. Settlement opens Seller Hub because a supported listing-settlement API has not been established.

With automatic updates and order coverage enabled, a newly verified Flipkart sale can lower every eligible listing sharing that Tally item, including listings in another connected seller account. If two tyres supply both single and pair listings, selling one single leaves zero complete pairs. Stockbridge checks on the **Marketplace stock** schedule and can reduce the pair listing to zero before the Tally bill arrives. A Tally purchase can still increase available stock. Sellers can also calculate, review and publish manually.

After importing listings, map a Tally item to a Flipkart SKU and stock location in Inventory. Confirm that this location draws on the selected company’s whole item balance. Choose the observed package count or enter the number of Tally units sold together. The choice survives restart. A changed package count flags package-based mappings for review and leaves seller-entered numbers in effect. The tyre minimum of five is an explicit choice for eligible destinations.

On 20 November the application imported 217 listings twice through Flipkart’s standard search and listing details. All returned shipping package counts, and 137 exposed a stock location. The sample SKU `145/70R12_X3_2_2` returned two packages and no stock location. A listing needs a known destination before Stockbridge can publish its stock. [Live API and catalogue checks](docs/integration/flipkart-validation.md#active-tyre-pack-sizes-on-2026-11-20)

The Tally adapter performs read-only XML exports. It requires stable company/item identifiers and validates the returned company context. Real installation compatibility, current-period balances and stock locations still need validation with Tally running. Unsupported quantities stay unknown; a failed read retains prior observations. See [the integration checklist](docs/integration/tally-validation.md).

In **Marketplaces > Add account**, choose Flipkart and enter a name and the seller-owned Self Access Application ID and Secret. **Save without verification** protects them locally without contacting Flipkart; **Verify and save** checks token access first. Each added account has its own Windows-protected credential folder outside SQLite/backups. Previously saved primary credentials are adopted without moving the file. Token requests go directly to Flipkart; this route needs no hosted Stockbridge authentication service. See [the self-access decision](docs/adr/0004-seller-owned-flipkart-self-access.md) and [setup steps](docs/customer-setup.md#optional-verify-seller-owned-flipkart-api-access).

**API credentials verified** confirms token access. Before editing, a complete import binds the account using a provider seller ID where supplied, or authenticated listing identities when standard search omits that ID. A fresh import checks continuity after restart or credential changes. An empty new account cannot establish ownership. HingadTyre confirmed use of Self Access for its own seller account. Independent-seller distribution eligibility remains open.

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

Open `http://127.0.0.1:4310`, enable Tally’s local HTTP server and load the intended company. Stockbridge discovers its items on a successful fetch. Use **Refresh Tally** to fetch immediately. The first connector reads company-wide stock. Confirm that balance supplies the Flipkart location when creating a mapping. **Marketplaces** also works independently of Tally.

The run commands use the existing build; they do not rebuild changed source. See [the development workflow](CONTRIBUTING.md#build-and-reload-behavior) for rebuilding and frontend development with automatic reload. The optional Windows launcher, [scripts/app.ps1](scripts/app.ps1), calls the same npm scripts while selecting a project-local Node runtime when available. Prefer npm directly when Node.js 24 is already selected.

## Verify

```powershell
npm run verify
```

This checks formatting, lint, TypeScript, tests and the production build. The same checks are configured in GitHub Actions. Use `npm run format` to apply formatting before verification. See [CONTRIBUTING](CONTRIBUTING.md) for the developer walkthrough, module map and sample development workflow.

Tests mirror their source modules under `tests/`. Use `npm test` for all tests, or pass a source test file/folder such as `npm test -- tests/client`. See [test organization and scope](CONTRIBUTING.md#test-organization-and-scope) for the mapping convention and what these tests establish.

Tests exercise real loopback HTTP transport with Tally-shaped fixtures, stock-policy examples, company boundaries, persisted drafts, stale reviews, settings, backups and reviewed manual and automatic publication, including stale or unconfirmed attempts. They also cover failed dashboard actions, serialized polling, diagnostic error details and database upgrades. Fixture success is not proof of live Tally/Flipkart compatibility. Transport tests use Node's local HTTP server and no seller credentials. Separately authorized live API and Postman checks are recorded in [Flipkart validation](docs/integration/flipkart-validation.md).

## Structure

- `src/domain`: pure pack arithmetic, named Flipkart tyre rule and separately tested allowance-consumption helper.
- `src/adapters`: read-only Tally XML transport, Flipkart self-access tokens and bounded listing search/detail/stock/price transport.
- `src/server`: local HTTP API, inventory commands and separate account/catalog/publication modules, plus stock refresh, polling, settings, backups, protected credentials and diagnostics.
- `src/server/storage`: SQLite schema, record conversion, validation and migrations.
- `src/client`: React dashboard with separate screens and focused inventory components. The credential form sends entered values to the local backend; it never reads saved secrets or accesses the database directly.
- `src/desktop`: packaged Windows start/status/stop orchestration; verifies the responding instance before sending a private stop token.
- `src/shared`: API contracts.

SQLite schema version 7 also retains pending order-triggered stock checks and evidence of whether a stock request finished or was never sent. Upgrades preserve existing order history, billing rules, manual matches and inventory settings. After an offline restore, reconcile earlier sales and confirm a starting date again before increasing calculated stock.

For an uncertain stock update, **Check result** reads current stock. When Stockbridge has proof that the previous request finished or was never sent, the seller can review fresh Flipkart stock and calculated availability, then approve recovery. Equal quantities close the review without a write. A lost submission reply with no proof of completion keeps the listing blocked. [Customer setup](docs/customer-setup.md)

## Data and operational limits

The runtime enforces one owner per workspace before opening SQLite, using an operating-system-held named pipe on Windows (an abstract socket on Linux for development/tests). Ownership releases on process exit. Application assets resolve from the application location, independently of the current working directory. `STOCKBRIDGE_DATA_DIR` selects an absolute local data folder; source checkouts default to their own `.data` directory. Network/device paths are rejected.

The backend continues while the browser is closed. The packaged Start command runs it without a persistent terminal; use Stop to shut it down cleanly. Source-checkout `npm start` remains a foreground process stopped with Ctrl+C. Shutdown drains an active Tally operation before closing SQLite. Windows automatic startup/service packaging is still pending.

Tally polling defaults to 30 seconds, avoids overlapping reads and backs off after failures. The catalogue timer refreshes mapped accounts and compares package evidence, including after a restart. **Refresh listings** runs the check on demand. Demo keeps its own database.

Self Access supports separate credential sets per added account. Demo mode uses clearly marked sample edits and never contacts Flipkart. Account credential checks and local disconnect affect only that account; disconnect does not delete its Flipkart application or change stock. Tokens remain memory-only and are renewed from returned expiry information. Credentials stay out of Git, logs, packages and SQLite backups; a new computer/Windows login needs its own setup.

**Back up now** creates a consistent SQLite copy, runs an integrity check and writes a manifest. Changing the folder checks write access and affects future copies. A [technician-assisted offline pilot restore](CONTRIBUTING.md#restore-a-pilot-backup-support-only) validates a preview/hash, takes a safety copy, preserves local settings and restores under exclusive workspace ownership. It retains any existing protected credentials in the same workspace; the backup does not supply them. Tokens are memory-only; check the intended account connection and refresh its listings after restarting. A moved/new workspace or another Windows user needs credential setup again. Restored observations require fresh reads and Inventory listings are paused. Marketplace seller bindings remain, account/listing freshness is cleared, and unfinished attempts become uncertain without automatic replay. Refresh each account before Apply or Check result. It is not the production order/policy reconciliation workflow and has no customer import UI. Automatic daily/weekly retention and production restore recovery remain unfinished; do not overwrite a running database manually.

Activity history is retained for 90 days. Diagnostics include request references and sanitized internal error causes/call sites, and rotate at 10 MB with one previous file. Configurable time-based retention and background-run correlation are pending. Logs omit source XML, credentials and customer order payloads. `.data`, `.tools`, `.cache`, `releases`, dependencies and build outputs are ignored by Git. The private runtime-control file is separate from SQLite backups and must not be shared in support bundles.

Customer acceptance still requires comparing real Tally balances and validating a specifically authorized write and readback for the intended seller, SKU and location. Selected godown balances, positive order-tracked allowances, verified zero-before-unlink, scheduled backups and full production recovery remain open. See the [release gates](docs/release-readiness.md).
