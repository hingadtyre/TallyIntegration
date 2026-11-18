# Flipkart connection and listing validation

**Updated 2026-11-18. Implemented and locally exercised with fixtures; current account approval, real token access, listing import and marketplace writes remain unverified.**

## Historical account evidence

On 2026-11-08, the user submitted **Stockbridge Local** in HINGADTYRES **Profile > Developer Access > Self Access**, with description **Tally stock integration** and [the project website](https://github.com/hingadtyre/TallyIntegration). It displayed **Pending** then; current approval has not been checked. The confirmation mentioned contact within seven working days, which was displayed guidance rather than a guarantee. No usable secret or real token was verified.

The seller browser displayed HINGADTYRES and one set-of-two tyre listing was matched to two shipping packages. Neither establishes authenticated API identity or a general pack-size rule. Earlier public discovery found listing and shipment candidates; official documentation is authoritative, and shipment lookup by existing identifiers does not establish complete order discovery.

## Implemented accounts and imports

The [seller-owned Self Access route](../adr/0004-seller-owned-flipkart-self-access.md) uses direct token requests and Windows current-user credential protection. HingadTyre confirmed internal own-account use. Independent-seller distribution eligibility remains separate; a provider-managed route would need its own approved registration, consent and hosted callback.

Marketplaces contains explicitly added account tiles. Each new account owns a protected credential folder; saved legacy primary credentials are adopted in place. Save without verification makes no external request. Verify and save checks token access before replacement; a failed replacement retains previous saved credentials. Tokens stay in memory and secrets are excluded from API responses, logs and database backups.

Token acceptance alone is not seller identity. Complete imports check every seller ID, reject mixed identities, bind the seller and reject a different seller on later refreshes. The same seller cannot be imported into two tiles. A new empty account cannot establish its seller binding. Process restart and credential operations require a fresh complete import before Apply or Check result. Failed refreshes preserve previous observations while invalidating permission to edit. A listing missing from a complete refresh retains its identity and unfinished attempts, but its observation time and stock become unknown. A recreated listing cannot inherit an old mapping just by reusing its SKU; first import of legacy mapped SKUs invalidates their verification pending pack review. Refresh is manual; marketplace/catalog interval settings do not start a poller. Demo accounts never call Flipkart.

## Official contracts reviewed on 2026-11-18

Reverification also covers safe SKU recreation: an unprotected, unmapped previous identity can be replaced with fresh Inventory identities, but mappings, holds, allowances, pause and unresolved attempts block that replacement. Offline restore retains newer verified seller bindings and unresolved attempts; a conflicting seller or weaker stock restriction prevents replacement.

No authenticated requests were made during documentation review.

| Operation                                                                                                    | Implementation and remaining limits                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Product search](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/product-search)       | Imports ACTIVE, INACTIVE, READY_FOR_ACTIVATION, ARCHIVED and INACTIVATED_BY_FLIPKART with 20-row batches. Checks totals, complete pages, duplicates and seller consistency. More than 20,000 listings in one state is rejected. Moving totals can fail a refresh; no transactional snapshot is promised.                                                                                                                   |
| [Listing details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-listing-details) | Batches ten SKUs, verifies listing/product identity, reads distinct locations and prices. Missing locations stay absent and invalid quantities stay unknown; pending inventory never replaces inventory. Any failed details batch fails the entire import. A fresh edit read does not reuse an unknown companion price.                                                                                                    |
| [Price update](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/update-price)           | Sends product identity and both integer INR prices using the current schema's selling_price. Details documentation also shows flipkart_selling_price, while the [older table](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsPriceAPI.html) says sellingPrice. Reads accept both documented read names; writes follow the current schema. Real authorized contract verification remains necessary. |
| [Inventory update](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/update-inventory)   | Sends an absolute quantity to one selected SKU/product/location and retains its known location status. It does not distribute stock across warehouses, apply the tyre floor or change physical Tally stock.                                                                                                                                                                                                                |
| Settlement                                                                                                   | No supported listing-settlement operation was established. Open in Flipkart opens Seller Hub. SSP is seller selling price; ESP is effective selling price. Neither is labelled settlement.                                                                                                                                                                                                                                 |

The adapter uses fixed production HTTPS endpoints, bearer authorization, redirect rejection, a 15-second request deadline and a 2 MiB response bound. Errors discard upstream response content and transport messages. The 18 focused mocked adapter tests passed during this delivery; they do not establish live compatibility.

## Apply, policies and recovery

Each Apply saves a durable attempt before sending, checks fresh values and conflicts, preserves the unedited companion price and submits only that edit. It checks per-SKU outcomes and reads back the edited value. A definitive rejection stays failed. Warnings, network/timeouts, server errors and malformed results remain uncertain unless readback matches. An unresolved outcome blocks further edits to that listing. In-flight attempts become uncertain after restart and are not automatically replayed.

Imported destinations update Inventory observations without granting a Tally mapping or pack verification. Stock Apply preserves holds and allowances, including when Pause is selected. Update once retains the automation setting; Pause Tally sync and update saves Pause; price-only changes leave automation untouched. Positive live stock under Limited sales is blocked until order reconciliation exists or the seller explicitly returns that destination to Auto. The confirmed policy change retains Pause and sends no stock. Inventory proposal publishing and automatic Tally writes remain disabled.

Schema 3 stores marketplace accounts, observations and attempts. Upgrades from schemas 1 and 2 validate and back up before transactional migration. Database backups exclude credentials. Offline restore accepts verified schema-2/schema-3 backups. Schema-2 backups have no marketplace records. For schema 3, restore preserves seller bindings, clears account/listing freshness and makes incomplete attempts uncertain. Existing local credentials remain outside the restored database; fresh import is required before Apply or Check result. This is not full production order/policy reconciliation and does not make a restored allowance safe.

## Remaining live acceptance

1. Verify current application approval, intended access-model eligibility and real token lifecycle for each seller.
2. Compare authenticated seller/listing/location identities and complete state coverage with Seller Hub, including empty accounts, archived listings and unavailable details.
3. Resolve price naming, fulfillment/location edit eligibility, inventory versus pending inventory, throttling and read-after-write propagation using sanitized authorized evidence.
4. For an explicitly approved small direct edit, confirm exact account/SKU/location, per-SKU response, API readback and Seller Hub value. Check rejection, uncertainty and restart recovery without blindly replaying a write.
5. Before automatic Tally synchronization, complete source-location/pack mapping, approved-order discovery, activation baselines, durable deductions, automatic jobs and full production recovery.

The [release checklist](../release-readiness.md) distinguishes implemented local behavior from customer acceptance. No real marketplace write was made to validate this implementation.
