# Inventory synchronization design interview

Status: design interview and supporting evidence, with product behavior, consolidated architecture and dashboard layout approved on 2026-11-07. The initial local foundation is implemented. Use [architecture.md](architecture.md) for the approved target behavior and [README](../../README.md) for delivered capabilities and remaining limitations. Candidate sections below preserve design history rather than describing a fully implemented application.

## Requested outcome

Synchronize stock from Tally to Flipkart initially, with support for other marketplaces and multiple seller accounts later. Agree on design and architecture before building.

## Requirements from the user

- Select a Tally company and display its stock items, including unmapped items.
- Associate existing Tally stock items with existing marketplace listings without creating products in either system.
- Support several duplicate listings and homogeneous packs of 1, 2, 3, 4 or more consuming the same stock item.
- Show Tally stock, marketplace titles and seller SKUs, pack sizes, observed marketplace stock, proposed quantities, and row actions.
- Prefer pack size supplied by marketplace product data and prevent casual editing in the stock table.
- Calculate proposed stock, review and edit it, then explicitly publish it.
- Prepare zero quantities for subsequent publication.
- Support row actions as well as bulk actions and filters for brand, name, and pack size.
- Automatically propagate stock changes caused by sales and purchases in Tally.
- Provide explicit listing automation controls and a finite sales allowance for manual reductions. A manual quantity edit must not implicitly freeze automatic stock updates.
- Apply the agreed minimum advertised quantity of five to eligible Flipkart tyre listings after calculating complete packs; publish zero when no complete pack is available. This applies to all eligible pack sizes, not just singles.
- Import newly added Tally stock items through refresh and background discovery.
- Provide detailed searchable history explaining stock calculations and publication outcomes.
- Provide initial seller-account connection and a way to add accounts later.

## Observed project and account context

- At the start of the design interview, the repository contained a README and agent guidance, with no application code constraining the architecture. The application has since been implemented to the scope recorded in README.
- During the design interview, the Flipkart Seller Dashboard displayed seller account HINGADTYRES. This is a historical UI observation, not a verified API seller identifier.
- Account identification does not establish API authorization. Account registration/connection remains outstanding until the setup flow and required access are verified.

## Candidate user experience

- First use: connect Tally, discover companies, connect a seller account, and review mapping readiness.
- Subsequent use: open the inventory dashboard with a persistent company selector and marketplace/account context.
- Parent rows represent unique Tally stock items; child rows represent mapped listings with location-specific inventory.
- Keep observed and proposed marketplace quantities in separate columns. Editing a proposal never changes the observed value.
- Suggested actions: Refresh from Tally, Refresh from marketplace, Calculate proposed stock, Publish reviewed changes, and Set proposed stock to zero.
- Adding a child chooses an existing listing. Because all Tally items are already visible, adding a parent should mean finding/showing an existing item rather than duplicating it.
- Removing a mapping defaults to publishing zero and verifying it before unlinking, with an explicit alternative to leave marketplace stock unchanged. It never deletes a product in Tally or Flipkart.
- Bulk scope must identify company, account, locations, matching listing count, and whether all filtered pages or only selected rows are included.
- Refresh imports source data into the application's saved view before updating the display; a saved database is compatible with source refresh.

## Candidate architecture

- A Tally connector reads company-scoped stock and product data through supported interfaces.
- An application database retains source observations, mappings, rules, proposals, publication jobs, and audit history.
- A common calculation engine operates on physical base units; marketplace-specific connectors handle authentication, listing discovery, stock reads/writes, locations, and response formats.
- A background worker detects changes, recalculates affected listings, sends updates, handles per-listing failures, and verifies outcomes.
- UI selection filters the view. It should not silently enable or disable company background synchronization.
- Version proposals against source stock and rules so a stale preview cannot overwrite a newer automatic update.
- Serialize or supersede stock jobs per destination; retries must not replay obsolete quantities.
- Manual operations and automatic updates must use the same calculation and publication path, with explicit override and pause semantics.
- Local Windows hosting and the TypeScript/React/Node/SQLite stack are accepted. Application packages have since been selected and pinned; durable publication jobs and Windows process supervision remain implementation work.

## Accepted decisions from the first interview round

- Open a company-centred dashboard after initial connection setup, with account context and explicit publication destinations.
- Keep stock in different Tally companies separate. Selecting a company displays only that company's stock, never a sum across companies.
- Initially support homogeneous packs consuming one Tally stock item. Recheck actual Tally/listing mappings for mismatches before enabling publication.
- Expose the full shared stock to every eligible pack and duplicate listing; do not allocate stock exclusively between offers in the first version.
- Apply `fulfillablePacks = floor(max(0, physicalUnits) / verifiedPackSize)`, then `advertised = fulfillablePacks == 0 ? 0 : max(5, fulfillablePacks)` for the Flipkart tyre policy. Missing, invalid, or contradictory pack metadata blocks calculation rather than defaulting to one.
- Keep complete-pack arithmetic separate from the named Flipkart tyre advertising policy so changing the policy does not require changing connectors or UI logic.
- The user accepts concurrent-sale exposure across duplicate listings before Tally billing and subsequent synchronization. Add low-physical-stock highlighting; do not treat the advertised floor of five as physical availability.
- The user reports that tyre listings cannot be ordered with cart quantity greater than one. This is an operating assumption provided by the user, not independently verified category-wide platform behavior.
- Start with periodic Tally stock reads; event-triggered refresh through Tally customization can be added later.
- Tally being closed/offline is acceptable when no billing occurs. On reconnection, refresh actual stock before sending new updates. Polling and remote update latency still apply after a bill is saved.
- Include both business activity/item history and an on-demand diagnostic log viewer. Retention defaults are accepted below; detailed sampling is an implementation choice.

## Accepted decisions from the second interview round

- Run locally on the Windows machine with access to Tally. Background synchronization continues independently of whether the browser dashboard is open.
- Superseded by the third round: the earlier proposal that publishing a manually edited stock quantity implicitly locks automatic updates does not meet the user's intended behavior. Manual reduction must still respond to sales and physical stock changes.
- A deliberate automation pause remains distinct from the manual adjustment. Avoid presenting a sales allowance as a lock or a technical failure.
- Provide a parent-row action to pause/resume its mapped listings. A parent with mixed child modes must show that mixed state rather than appearing wholly locked or wholly automatic.
- Bulk actions apply to selected listings if any are selected; otherwise all matching filtered listings across pages. Display company/account/count explicitly and exclude unmatched sibling listings.
- Each company has an explicit automatic-sync setting independent of the company currently displayed. Unavailable Tally companies show offline while retaining their settings.
- Setup explicitly chooses which Tally stock locations supply each marketplace inventory location. Never combine company stocks implicitly.

## Accepted decisions from the third interview round

- Use React and TypeScript for the dashboard, Node.js and TypeScript for the backend, and SQLite locally initially. Preserve a practical path to a remote deployment/database later.
- Resuming automation obtains fresh Tally stock and recalculates before publishing; do not replay old manually entered quantities. Apply any active allowance as well.
- If source stock, pack size/mapping, or rules change after preparation, affected proposal rows require another review. Preserve the user's proposal visibly for comparison.
- Polling intervals are user-configurable; the user wants to change them through settings. Proposed defaults remain 30 seconds for Tally, five minutes for marketplace observations, and 15 minutes for catalog metadata.
- Low-stock highlighting starts at five or fewer physical pieces and is configurable per item.
- Permit the verified one-tyre-per-package fallback. Missing/contradictory metadata blocks the affected mapping and changed metadata requires rechecking it.
- During Tally outages retain the last published marketplace values, show stale/offline observations, and fetch fresh stock before resuming publication. Revalidate pending work rather than replaying stale quantities.
- The user explicitly clarified that setting a particular listing to one should mean it becomes zero after one sale even if Tally stock goes from four to three. A persistent display cap of one is rejected because it would continue advertising one.
- The user further clarified that the manual quantity belongs to the particular marketplace listing, not the Tally item or its other mapped listings. Consume that listing's allowance only for its own qualifying sales. Dashboard quantity edits do not change Tally stock.

## Accepted allowance lifecycle and manual zero

- An exhausted listing allowance remains zero until the seller explicitly grants more sales or switches the listing back to Auto. Purchases, cancellations, and returns do not automatically reopen it; those events can be shown for review.
- Editing proposed listing stock uses `Allow N more sales`; an edited zero means a manual out-of-stock hold for that listing. The reviewed publish action activates the change; a draft alone does not change Flipkart or active automation policy.
- A manual out-of-stock hold takes precedence over positive Tally stock and the minimum-five advertising rule. It affects only selected listing destinations and leaves Tally and sibling listings unchanged.
- Normal calculation, source-stock refresh, bulk publication and process restart must preserve active allowance/hold policies. Returning a listing to Auto must be explicit, then fetch fresh data and recalculate.
- Reconcile an exhausted allowance or explicit zero hold against observed marketplace stock. If a marketplace cancellation or external edit restores positive availability, queue an absolute zero to enforce the accepted hold; this is an intentional exception to report-only marketplace drift for normal Auto listings. Show the mismatch and pending/failed correction until zero is verified; do not promise uninterrupted zero between observations.
- The user asked why order observation is needed when Flipkart handles its own stock changes. The application observes listing sales to consume its internal allowance and prevent later synchronization from refilling the listing; it must not subtract the sale again from already reduced observed marketplace stock or write a corresponding deduction into Tally.
- Accepted consumption timing: the first qualifying approved Flipkart order observation, before Tally billing. Verify available-versus-pending inventory semantics and event timing against authenticated responses; API integration has not been performed.

## Sales allowance design (replaces implicit manual locks)

- Offer a mode named `Limited sales`, with text such as `1 sale remaining`, alongside normal `Auto` and a separate explicit `Paused` mode.
- A value of one means one additional listing unit (one complete pack) may be sold, not one physical tyre and not a permanently replenished advertised cap.
- Proposed calculation: compute complete packs, apply the Flipkart floor, then limit the result to the remaining allowance. Zero complete packs or zero allowance always produces zero. Invalid/stale inputs remain blocked, not converted to a fabricated stock zero.
- Consuming allowance requires a qualifying sale signal for the exact listing. A stock balance change alone cannot identify which listing sold or distinguish sales from other adjustments.
- Proposed implementation: read identifiable Flipkart order items, process only qualifying newly observed sales for the allowance period, and deduplicate each order-item quantity. Do not consume the same allowance again when the corresponding Tally bill later reduces stock. The alternative of using Tally bills requires verified exact-listing/order references in those bills.
- Full shared-stock behavior across other listings is unchanged. An allowance limits this listing; it does not reserve physical stock exclusively or protect against concurrent platform orders before a zero update takes effect.
- Accepted: keep exhausted allowance at zero until the seller explicitly grants more allowance or switches back to normal Auto. Purchases, cancellations and returns do not replenish allowance automatically.
- Accepted: manual quantity edits use the finite allowance mode, with zero creating a manual out-of-stock hold. Exact activation baseline, qualifying order statuses, and in-flight reconciliation remain to be specified before implementation.
- Preparing an allowance remains a draft until the publish/activation action. Persist the active policy and its generation and revalidate queued jobs; publication failures must remain visible as desired-vs-confirmed differences.
- Activation must establish a durable baseline that excludes previous orders while handling new orders during publication. Retries reuse the same activation; they must never reset allowance. When the order feed is stale, defer automatic increases for limited listings until sales have been reconciled, rather than refilling from an outdated remaining count.

Official feasibility evidence: [Flipkart shipment/order details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-shipment-details-by-internal-id) documents order-item ID, listing ID, seller SKU, quantity, order date and status. These provide an identity and quantity basis for a listing-specific allowance ledger; actual authenticated access, discovery/polling coverage and activation-time reconciliation remain unverified. Stock-only polling is insufficient to attribute a sale to one of several duplicate listings.

## Proposed automation-status presentation

| Presentation                     | Meaning                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto                             | Eligible for automatic publishing, subject to company enablement, verified mapping and fresh data.                                                               |
| Limited sales: 1 remaining       | Automatic updates continue, bounded by physical stock and the remaining finite sales allowance.                                                                  |
| Allowance used up                | Proposed quantity remains zero until allowance is explicitly reset or normal Auto is selected; show remote publication status separately.                        |
| Kept out of stock                | Seller explicitly set a zero allowance. Target remains zero despite physical stock or restocking; show Pending/Confirmed/Failed publication independently.       |
| Pause icon + Auto updates paused | A separate, deliberate pause of publication; keep observing stock and showing differences. This is not the behavior implicitly applied by manual quantity edits. |
| Needs attention                  | An invalid mapping, missing pack evidence, or another validation problem prevents publishing.                                                                    |
| Offline                          | Fresh source data or marketplace connectivity is unavailable. Preserve independent automation settings.                                                          |

Keep stock policy (Auto, Limited sales, Kept out of stock) separate from publication state (Running or Paused), connection health, and last publication result. Pause is an overlay, retaining the underlying policy. A listing can be paused and offline simultaneously. Tooltips explain the active allowance or deliberate pause; use text and accessible labels in addition to the icon and colour.

## Final accepted behavior rules

- Explicit Pause blocks every automatic marketplace publication, including zero stock and enforcement of an active hold. Source observations, order ingestion, allowance consumption and warnings continue. Explicit reviewed manual publication is allowed. Resume refreshes inputs and applies the retained policy; it does not silently clear a sales allowance or hold.
- Consume sales allowance on the first qualifying approved order for the exact listing, before Tally billing. Count each order-item quantity once and do not deduct the same sale from already reduced observed marketplace stock or from Tally.
- Normal Auto listings are recalculated/published on relevant Tally stock changes or explicit publication. Marketplace-only differences are observed and reported without automatically refilling a sold listing while its Tally bill is pending.
- Limited sales and zero holds retain their enforcement rules when running. If explicitly paused, they do not publish automatically. Use these same terms, precedence and behaviors in parent/child rows, bulk actions, settings, jobs, logs, restart and restoration.

## Accepted implementation stack and proposed deployment details

- TypeScript for application code, including isolated complete-pack and Flipkart advertising-policy functions.
- React with TypeScript for the local browser dashboard.
- Node.js with TypeScript for the local application API, connector calls, scheduler, and background worker; build and type-check before distribution.
- SQLite on the local disk for companies, connections, stock observations, mappings, rules, drafts, durable pending jobs, and business activity history. Keep database access behind the backend and use bounded transactions; operational logs use rotated files.
- Store pending jobs durably so process restart does not lose work. Revalidate source versions and lock state before dispatch; supersede obsolete jobs rather than replaying them blindly.
- Package Windows startup, shutdown, restart-on-failure, and credentials access deliberately. Node is a runtime, not a built-in Windows Service host; the deployment needs a suitable service wrapper or a verified Windows-managed launch mechanism.
- Runtime validation of Tally/marketplace responses remains necessary: TypeScript checks source code but does not prove external data is valid.
- A C#/.NET backend was considered for its first-party Windows Service support; the accepted TypeScript approach trades that native hosting convenience for one application language across dashboard and backend.
- The local server should bind to loopback by default. Network/remote dashboard access is a separate future requirement.

Supporting references: [TypeScript overview](https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html), [Node TypeScript execution and lack of automatic type checking](https://nodejs.org/api/typescript.html), [SQLite local use and concurrency limits](https://www.sqlite.org/whentouse.html), [Windows Service hosting requirements](https://learn.microsoft.com/en-us/windows/win32/services/service-programs), and [.NET Windows Worker Services](https://learn.microsoft.com/en-us/dotnet/core/extensions/windows-service). The selected runtime range and pinned packages are now declared in [package.json](../../package.json) and [package-lock.json](../../package-lock.json).

## Future remote deployment

- Keep database reads/writes in a storage module behind the application backend. Stock policies and dashboard behavior should not depend on SQLite-specific SQL or direct file access.
- Use stable identifiers, explicit company/account/location ownership, and versioned schema migrations. Keep types and transaction assumptions explicit so a later storage adapter can be verified against the same behavior.
- A future deployment could move the backend and database to a server and migrate data to a server database such as PostgreSQL. The Tally connector remains on a machine that can access Tally and communicates with the backend over authenticated HTTPS.
- This is a planned migration, not an automatic database URL swap: transfer and validate records, adapt queries/transactions/jobs, secure remote access, test offline recovery, and perform a controlled cutover with only one active publishing owner.
- SQLite stays on local disk for the initial deployment. A future remote service is accessed through the backend rather than exposing the database directly to browsers.

## Runtime settings changes

- Proposed behavior: polling intervals can be saved from Settings without an application or Tally restart. Persist validated settings and reschedule future runs in the live scheduler.
- Let any current poll complete using its captured settings; schedule subsequent work with the new settings. Never start overlapping polls because an interval was shortened.
- Show the effective interval, last successful run, and next planned run; retain a separate Refresh now action.
- Validate unreasonable values and respect platform throttling/backoff. A configured interval is not a promise that an unavailable external system can be refreshed at that frequency.
- Record settings changes in activity history, and retain them across restarts. Exact minimum intervals and per-company/account overrides remain to be selected after measuring integration load.

## Accepted mapping removal, backups, and log retention

- Remove mapping defaults to setting marketplace inventory to zero and verifying it before unlinking. Offer an explicit alternative to leave the remote quantity unchanged and stop managing it. Never delete the source product or listing.
- For zero-before-unlink, prevent new automatic positive jobs, finish or reconcile in-flight requests, send zero, and verify the destination outcome before marking the mapping removed. If publication/verification fails, retain a visible pending-removal mapping that cannot republish positive stock; retry or let the user explicitly choose the leave-stock alternative.
- Make automatic daily database backups and a backup before application upgrades. Initially retain seven daily and four weekly backups, with a manual Back up now action.
- Settings must show the backup folder and let the user change it. Provide an Import backup / Restore from backup action.
- Restore replaces current local application data rather than merging it, creates a verified safety backup first, and leaves outbound synchronization paused until fresh reconciliation and user review are complete. This replacement/review behavior is accepted.
- Retain business activity for 90 days and technical logs for 30 days initially. Both durations are configurable; support export and temporary detailed debug logging.
- Retention of diagnostic/business logs must not delete operational state needed to deduplicate orders, compute active allowances, recover unresolved jobs, or preserve current zero holds. Such records have their own lifecycle.

## Backup and restore design

Settings > Backups should show: folder with Change/Browse, a write-access check for the background application, schedule and retention, last successful backup, next backup, status/error, Back up now, a list of backups, and Restore from backup.

- Changing the folder takes effect for future backups without restarting. Existing files remain where they are unless the user explicitly chooses a separate move/export action. Check the folder before accepting the change; a missing drive or unwritable destination produces a visible failed-backup status, not a false success.
- Use a consistent SQLite snapshot rather than an uncontrolled copy of the active database file. Package it with backup time, application/schema version and a manifest. Verify the completed backup before treating it as usable or removing older retained backups.
- Backups contain application settings, companies/account references, mappings, rules, allowances/holds, retained business history and the operational records required for recovery. Raw diagnostic logs are exported separately. Keep API credentials outside portable backups by default; verify/reconnect accounts on another machine.
- Pre-upgrade and pre-restore safety backups are identified separately from daily/weekly rotation. Exact retention for these and manually created backups remains to be chosen.

Restore flow (replacement, safety backup and review-before-resume are accepted; technical validation/activation details will be verified during implementation):

1. Choose a backup from the saved list or import a compatible backup file. Show its date, app version, company/account identities, and record counts before making changes.
2. Validate file integrity, format, schema compatibility, and relationships in a staging location. Reject incompatible/newer formats with a clear explanation; do not overwrite the active database before validation succeeds.
3. Explain that this replaces this application's local data rather than merging it and does not roll back Tally or marketplace data. Obtain the restore action confirmation in the product.
4. Stop outbound publishing, resolve or record in-flight request uncertainty, and take a verified safety backup of the current local state. Keep the current installation's backup location and machine-specific connection settings rather than blindly importing paths from another machine.
5. Replace the application database atomically under exclusive application access. The app may briefly enter maintenance mode/reconnect its UI; ordinary folder/interval settings changes do not require this.
6. Mark restored cached stock and drafts stale. Do not replay restored queued publications. Keep outbound synchronization paused behind a recovery check even if the backup had automation enabled.
7. Read fresh Tally stock, marketplace stock and relevant orders; verify company/account/location identities. Rebuild allowance consumption from stable order identities and its activation baseline. An old allowance of one must not become sellable again if it was consumed after the backup.
8. Show the reconciled preview, including restored allowances, zero holds and any policy changes compared with the preserved current state. Resume only after review. If order history or policy history is insufficient, require explicit review/reset of affected listings rather than guessing.

SQLite provides supported snapshot mechanisms through its [Online Backup API](https://www.sqlite.org/backup.html); its [integrity and foreign-key checks](https://www.sqlite.org/pragma.html#pragma_integrity_check) can contribute to validation. Application/schema compatibility and fresh inventory reconciliation are additional application responsibilities.

## Design tree and unanswered decisions

### Completed design review

The final product rules (Pause precedence, approved-order allowance consumption, and report-only marketplace differences for normal Auto), consolidated architecture and dashboard layout were accepted on 2026-11-07. The user authorized implementation and the initial foundation has been delivered. Continue within that approved scope; bring back only unresolved material choices exposed by new work or integration evidence.

### Integration evidence and implementation follow-through

These are engineering checks or details, not additional blanket user-approval gates:

- Verify installed Tally version, source identities, units/godowns, item-by-location extraction, rename/restore behavior, and performance. Read resulting stock for sales, purchases, edited/deleted bills and adjustments.
- Establish authenticated Flipkart access for the intended account; verify listing packages, stock location/available/pending semantics, order discovery/statuses, rate limits, and allowance activation/reconciliation.
- Define durable job ordering, proposal versions, partial-result reporting, retry/recovery and deduplication. Unresolved integration facts may expose a concrete product trade-off later; bring back only those decisions.
- Maintain the selected packages and choose the Windows startup/restart mechanism; implement protected credential storage, scheduled backup/restore, and controlled upgrades. Manual verified backups are available within the current README scope. Keep retained operational state independent of display-log retention.
- Use the approved dashboard layout and consolidated architecture as implementation inputs. Record subsequently authorized changes in the current design docs instead of reopening completed approval steps.
- Multi-user roles, additional marketplaces and other category policies are future scope unless requested; preserve the agreed extension points without silently expanding the first release.

## Evidence to verify during integration discovery

- Flipkart listing APIs describe location-specific inventory. Stock location is part of the destination, not merely a UI filter.
- The documented listing response does not establish a reliable product pack-size field; shipping packages are a different concept.
- Tally version and configuration affect supported interfaces and event options. Do not assume native webhooks or access while Tally is closed.
- The proposed promotion threshold of five is the user's business hypothesis; it has not been established as a general Flipkart platform rule.

## Decision records

- [ADR-0001: Shared stock and the Flipkart tyre advertising policy](../adr/0001-shared-stock-flipkart-tyres.md)
- [ADR-0002: Local TypeScript application with SQLite](../adr/0002-local-typescript-sqlite.md)

## Proposed polling and diagnostics defaults

- Read selected/configured Tally company stock every 30 seconds initially; make the interval configurable and measure extraction duration before increasing frequency.
- Prevent overlapping polls and back off on connection failures. Publish changed mapped stock after a successful read; do not send unchanged values on every poll.
- Refresh marketplace observations periodically (candidate: five minutes) for display and drift detection. Accepted: do not automatically refill a normal Auto listing solely because Flipkart reduced it after an order while Tally is unchanged.
- Refresh catalog/package metadata on demand and periodically at a slower interval (candidate: 15 minutes). Package changes invalidate the previous mapping verification.
- Give zero-availability updates priority, while preserving destination ordering and superseding obsolete pending jobs.
- Re-read before retrying after an outage. A pending old positive update must not run after a newer zero result.
- Diagnostic viewer: timestamp, level, module/operation, company, listing, synchronization-run ID, duration, retry, and error details; filter, search, pause/follow, and export.
- Keep normal information/warning/error logs continuously with rotation. Enable detailed debug traces on demand for a bounded time. Do not log credentials, customer personal data, or every function call indiscriminately.

## Live pack-size evidence from HINGADTYRES

Inspected existing UI values without submitting listing edits:

| Seller SKU         | Product / FSN      | Observed evidence                                                                                                                                                                                                                                                   |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `145/70R12_X3_2_2` | `VTEGYHJKPW2NFEYP` | Public product page explicitly shows `Selected Set of: 2`; seller listing configuration contains two packages, with seller package IDs 1 and 2.                                                                                                                     |
| `265/65R17_4`      | `VTEGYZZYAFH2SNJ8` | Seller listing configuration contains four packages; package IDs are ordered 4, 2, 3, 1. This confirms counting package entries, not treating an ID or its position as the quantity. The public set attribute was not independently checked for this second sample. |

[Verified set-of-two product page](https://www.flipkart.com/ceat-145-70-r12-milaze-x3-69t-4-wheeler-tyre/p/itm59ae5cee36269?pid=VTEGYHJKPW2NFEYP).

The official [listing details API](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-listing-details) documents `POST https://api.flipkart.net/sellers/listings/v3/details` with `sku_ids` and response `available[sku].packages[]`. This provides a concrete API candidate for package-count extraction. No authenticated API request has yet been made; credentials/access and actual response agreement with the UI remain to be verified. The seller browser session alone is not proof of API authorization.

Proposed validation before publication: identify the exact company stock item and seller SKU/FSN; compare tyre brand, model, dimensions, base unit, catalog set size when accessible, and package count. Maintain the pack-size source and verification time. Do not infer pack size solely from SKU suffixes, product-title digits such as `4 Wheeler`, or package identifiers. Missing/contradictory evidence blocks that mapping, while verified mappings can proceed.

## Official-source findings

Checked during the initial interview on 2026-11-07. Documentation establishes capabilities, not successful access for this seller or this Tally installation.

- [Flipkart authentication](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration): distinguishes seller self-access applications from partner applications authorized by sellers. Browser sign-in alone does not connect an application.
- [Flipkart inventory updates](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsInventoryAPI.html): location-specific absolute inventory values, batches of up to ten SKUs, and per-SKU outcomes that must be checked even on an HTTP-success response.
- [Flipkart listing details](https://seller.flipkart.com/api-docs/listing-api-docs/LMAPIRef.html#post-listings-v3-details): product titles and location inventory are documented; a reliable sellable-pack multiplier is not established by this response.
- [Flipkart order management](https://flipkart.github.io/fk-api-platform-docs/docs/order-management-intro): positive stock permits orders, with no seller acceptance gate. [Notifications](https://seller.flipkart.com/api-docs/order-api-docs/NotifIntro.html) require setup and can be delivered more than once; account eligibility and prerequisites need verification.
- [Tally integration prerequisites](https://help.tallysolutions.com/pre-requisites-for-integrations/): live integration requires Tally running and a company loaded. A connector alone cannot keep closed Tally data live.
- [Tally XML](https://help.tallysolutions.com/xml-integration/) supports explicit company scope; [native JSON](https://help.tallysolutions.com/tally-prime-integration-using-json-1/) is documented from TallyPrime 7.0. Installed version remains unverified.
- [Tally-initiated integration](https://help.tallysolutions.com/integration-initiated-from-tally/) and [TDL events](https://help.tallysolutions.com/actions-events-buttons-keys-in-tdl/) provide customization options; do not assume a built-in universal durable webhook.
- [Tally stock FAQ](https://help.tallysolutions.com/tally-prime/inventory/stock-items-faq/) explains that accounting and physical-stock updates can differ. Read authoritative resulting stock rather than calculating changes from bill quantities alone.

Design implication: polling and reconciliation provide a baseline, with event-triggered reads as an optional acceleration. Reservations require matching marketplace orders to Tally stock-affecting records to prevent double subtraction. Publishing a full physical pool independently to every pack and duplicate cannot guarantee prevention of simultaneous overselling. Strict allocations require acknowledged decreases before increases when redistributing stock; external edits and stale source data still require reconciliation.
