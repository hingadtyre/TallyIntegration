# Marketplace account and listing management

**Status: Approved for implementation on 2026-11-18; account/listing management and direct Apply are implemented with local fixtures. Live account/API acceptance remains unverified.** The seller confirmed the consolidated flow and requested implementation. See [current delivery status](../../README.md) and the [inventory architecture](architecture.md).

## Confirmed scope

- Add an account-tile entry point for connected marketplaces. The first version must support multiple Flipkart seller accounts, with independent credentials, connection status and dashboards. Future marketplaces should fit the same navigation pattern.
- Opening a tile shows that seller account's marketplace listings, including listings without a Tally mapping. Listings come from Flipkart, not from the selected Tally company's stock items.
- This is a separate marketplace-management view. Selecting or connecting a Tally company is not a prerequisite. Existing Inventory remains the company-scoped Tally synchronization workspace.
- Use the Seller Hub listing page as the interaction reference: product/title, SKU, MRP, price, stock, settlement where supported, search and filters. The seller wants real marketplace edits, not only local stock proposals.
- The first version includes stock, MRP and seller selling-price editing. The seller accepted an Open in Flipkart action for settlement until a supported API is verified. Creating products, order management and full Seller Hub feature parity have not been requested for this flow.
- Each stock or price editor has its own Apply action, following Seller Hub. There is no required global Review changes -> Publish step for this view.
- When editing stock on a Tally-managed listing, let the seller choose Update once or Pause Tally sync and update. Price-only edits leave stock automation unchanged.
- Existing Limited sales and Kept out of stock rules remain effective for direct stock edits. If the quantity conflicts with the rule, require an explicit policy change first; neither Apply nor Pause silently removes a hold or grants allowance.

## Implemented view

Navigation: **Marketplaces -> seller-account tile -> Listings**. A new live workspace shows Add account without prefilled seller tiles. Add account offers the marketplace picker, currently Flipkart only; each added account has independent credentials and status. Saved legacy primary credentials are adopted in place. Keep the account name and marketplace visible in the listing page header, with a route back to the account tiles and an Add account action at the entry point.

Use one parent row per listing: image/title, seller SKU and product reference, status, MRP, seller selling price, observed stock and actions. Show the last successful refresh time and connection errors. Title and SKU remain display-only unless a supported edit operation is verified.

Stock is location-specific. Expand a listing into location rows when it has several destinations; use the sole destination directly when it has only one. Do not interpret an edited total as an instruction to copy that quantity to every location. Price and MRP follow their API scope rather than being repeated as independent warehouse prices.

Refresh reads all five documented states and complete pagination; search and the status filter then cover the complete saved import. Account-wide results must cover all applicable listing states, not just Active. Additional filters such as brand, pack size or stock ranges require reliable fields and complete coverage of the requested result set; filtering one loaded page must not be presented as searching the entire account.

The listing source is Flipkart through the local backend. Local observations support display and filters, with timestamps and refresh state; this does not make Tally the source of listing data. Failed or partial refreshes must not remove unseen listings or imply a complete account import.

A recreated SKU can be imported with fresh, unmapped Inventory observations only when its previous identity has no mapping, hold, allowance, pause or unconfirmed update. Protected identities still block the complete import until resolved. Completed update history remains attached to the original listing; old editors cannot write to the replacement.

## Per-field Apply interaction

The seller selected field-level Apply rather than a global review/publication step. The observed Seller Hub interaction is a pencil beside a row's value, a small editor and its own Apply button. The following details implement that choice:

1. Open the editor for the selected listing's stock or price value. Keep the current observed value visible and let the seller enter a new value; typing does not publish.
2. For Tally-managed stock, show the current automation state and the Update once / Pause Tally sync and update choice in that editor. Display an existing Limited sales or Kept out of stock rule and offer Change stock policy if the entered quantity conflicts. That action must explicitly change the policy through its existing workflow; returning to the stock editor revalidates the edit. Unmapped listings do not need a Tally choice. Price and MRP editors do not alter stock automation.
3. Apply validates and submits only that edit for the displayed account and destination. It must not submit other rows' drafts or unrelated price/stock edits. When the price API requires both MRP and selling price, preserve the unedited companion value from a fresh read; report a conflicting change rather than silently overwriting it.
4. Show Applying, Checking result, Updated or the specific failure beside the edit. Prevent duplicate submission while it is in progress. Preserve the entered value on failure so it can be corrected or retried; an uncertain result needs reconciliation before replay.
5. Closing or cancelling an editor before Apply discards its unsent edit. A later API result must stay bound to the original account/listing/location even if the user navigates to another account.

Apply is the explicit marketplace-write action for this view. It uses the shared backend publication and verification mechanisms; its familiar UI does not bypass validation or make an API request atomic across unrelated fields.

## API and Seller Hub evidence

Reviewed official Flipkart v3 documentation and the open Seller Hub listing page on 2026-11-18. No authenticated API requests or marketplace writes were made during this review. Documented operations still need account-authorized contract checks before production use.

A second read-only Seller Hub inspection confirmed separate Update Stock and Update Bank Settlement editors, each with its own Apply button. Both were closed without changing or submitting values. This confirms the requested interaction pattern; it does not establish a public settlement API or production stock/price write behavior.

| Capability                         | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing search and product display | [Product search](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/product-search) documents title, image, SKU, seller/listing/product identifiers, vertical, MRP, SSP (Seller Selling Price) and ESP (Effective Selling Price, nullable). It accepts search text and an internal-state filter, with 20 results per batch. ESP is not documented as settlement.                                                                                                                             |
| Listing enumeration                | [Listing search](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/listing-search) supplies listing/product/SKU references and continuation paging. Its supported status coverage must be distinguished from the richer product-search states.                                                                                                                                                                                                                                              |
| Location stock reads               | [Listing details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-listing-details) documents location identifiers, status, inventory and pending inventory. Pending inventory semantics and fulfillment-specific edit eligibility need verification.                                                                                                                                                                                                                                  |
| Stock edits                        | [Inventory update](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsInventoryAPI.html) accepts absolute non-negative inventory for specified SKU/product/location destinations, up to ten SKUs per request. A successful HTTP response can still contain individual SKU failures.                                                                                                                                                                                                         |
| MRP and selling-price edits        | [Price update](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/update-price) accepts product identity and a price object containing MRP, selling price and currency. Both price values are required; editing one must preserve the other deliberately using current data. The [older seller reference](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsPriceAPI.html) differs in naming in its field table; verify the current request contract.                   |
| Title and SKU edits                | No title update or SKU rename operation was established by the reviewed listing update contracts. Display these fields without promising edits.                                                                                                                                                                                                                                                                                                                                                                 |
| Bank Settlement editor             | Seller Hub visibly exposes an editable Bank Settlement field and shows Average Fees and Taxes, Seller Price, Customer Logistics Fee and Listing Price. This establishes the UI feature, not a supported public API for reproducing the calculation. No values were changed or applied.                                                                                                                                                                                                                          |
| Settlement API limit               | No public listing settlement-estimate or settlement-edit operation was found in the reviewed contracts. Actual order settlements are a different concept: see [platform terminology](https://seller.flipkart.com/api-docs/FMPlatOverview.html) and the [reports overview](https://seller.flipkart.com/api-docs/reports-api-docs/RMAPIOverview.html). Reports do not establish a listing price-editor API. Do not label SSP or ESP as bank settlement or reconstruct the calculation from one displayed example. |

## Boundary with Tally synchronization

Separate pages can still refer to the same real marketplace destination. A direct stock edit therefore needs an explicit interaction with Tally automation. Merely hiding the Tally company selector does not isolate the stock being changed.

The direct-edit command means "set this account/listing/location stock to N". It does not automatically mean "allow N more sales", apply the tyre stock floor, or change physical Tally stock. Entering zero does not silently create an Inventory out-of-stock hold. The existing Inventory allowance/hold semantics remain as defined in the [architecture](architecture.md) and [glossary](../../GLOSSARY.md).

The seller explicitly chose to preserve Limited sales and Kept out of stock constraints. A held listing cannot receive a positive direct stock update until the seller changes that policy. If the remaining allowance is one, a direct quantity of five cannot bypass it. Show the current rule and an explicit Change stock policy action; never treat the entered stock as an implicit allowance grant. This applies even when automation is paused. Revalidate the current policy and allowance at dispatch as well as when opening the editor.

Update once leaves the current automation setting and saved policy in place, so an eligible later Tally update can replace the quantity. It does not resume an already paused listing. Pause Tally sync and update stops automatic stock writes, including zero corrections, until resumed. The saved policy and allowance accounting remain in place. Pausing alone is not approval to erase a hold or grant more allowance. These consequences must appear in the stock editor before Apply.

Price-only changes should leave stock automation unchanged. All stock writers must coordinate the same canonical destination and ordered publication path, so old Tally jobs cannot silently replay over a newer manual decision. Recheck destination, current versions and the chosen automation behavior at dispatch. Track per-field/per-destination results: a price update may succeed while its stock update fails, and retry must not resend already confirmed changes unnecessarily.

## Implementation boundaries

- Account-scoped connection management uses separate protected credentials and seller bindings. Fresh import must verify the bound seller after restart or credential operations; different-seller replacement and duplicate sellers are rejected. Empty accounts cannot establish a new binding. Bind credentials and observations to verified seller identity; do not use a friendly tile name or SKU text as identity. Preserve the existing local credential protections described in [ADR 0004](../adr/0004-seller-owned-flipkart-self-access.md).
- Share account/listing/location identities between Inventory and Marketplaces. Add marketplace management commands separate from Tally-dependent calculation and proposal validation.
- Keep Flipkart transport, search pagination, field conversion, supported operations and per-SKU error handling in the Flipkart adapter. Other marketplace adapters can expose their supported fields without pretending that every platform has a Flipkart settlement control.
- Persist observations and direct-update attempts in schema 3; editor values remain local to the open editor until Apply. Writes use the account-serialized backend. Incomplete attempts become uncertain after restart and are not automatically replayed. Do not store account secrets in listing records or portable backups.
- Distinguish locally edited, submitted, confirmed and failed values. Readback/reconciliation confirms the edited value; the reviewed write documentation does not promise immediate propagation or an asynchronous job contract.

## Decisions from the follow-up interview rounds

- **Q4 accepted:** choose the automation behavior when editing stock: Update once or Pause Tally sync and update.
- **Q5 corrected by the seller:** use Seller Hub-style Apply for each stock or price editor. The earlier global Review changes -> Publish recommendation was not accepted for this view.
- **Q6 accepted:** start with supported stock, MRP and selling-price edits, with Open in Flipkart for settlement until a supported API is verified.
- **Q7 accepted:** require an explicit policy change before a direct stock edit can conflict with Limited sales or Kept out of stock. The alternative of silently overriding those rules was rejected.

## Delivery and remaining acceptance

The seller approved independent account tiles, account-wide listing views, supported fields, per-editor Apply, explicit stock-automation choice, preserved policies and Seller Hub settlement fallback. Implementation is authorized; no further design-confirmation gate remains.

Direct Apply is available in live mode; sample Apply only changes sample observations. Inventory proposal publishing and automatic Tally publication remain disabled. Positive live stock under Limited sales is blocked because order reconciliation is unfinished. The separate Confirm automatic policy action removes a destination's hold/allowance, retains Pause and sends no stock by itself.

Schema-1/schema-2 upgrades are backed up and migrated to schema 3. Offline restore preserves seller bindings, clears freshness and leaves unfinished attempts uncertain. Fresh import is required before editing or checking outcomes. Full production order reconciliation remains unfinished.

Restore retains current verified seller bindings and unfinished marketplace attempts even when newer than the selected backup. Current listing identities are retained as stale records, and restored versions advance beyond both saved and current versions so an old browser editor cannot become valid again. Conflicting seller identities, removal/weakening of current holds and allowances, or loss of a paused destination refuse replacement and require reconciliation. A backup cannot erase evidence of a possibly sent marketplace request.

Local fixtures exercise account/import/edit/recovery behavior. No real token, import or write has been verified. Official price naming, fulfillment-specific location eligibility, empty-account identity and read-after-write propagation remain live checks. See [Flipkart validation](../integration/flipkart-validation.md) and [release readiness](../release-readiness.md).
