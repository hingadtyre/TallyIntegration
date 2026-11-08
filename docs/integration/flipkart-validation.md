# Flipkart connection status

The seller browser displayed HINGADTYRES. One set-of-two listing was matched to two shipping packages during the design interview. No app registration, API credentials, authenticated listing import, order import or live inventory write has been completed.

Public Orbit discovery on 2026-11-07 located listing inventory/search and shipment lookup candidates. Integrating the shipment candidate returned a partial fit: bearer-authenticated `GET /sellers/v3/shipments` needs known shipment/order/order-item identifiers, and does not establish listing stock or complete order discovery. Some discovery listing URLs omitted the `/sellers` prefix; official API documentation remains authoritative rather than copying the search summary blindly.

The local application therefore has no marketplace transport or publishing implementation yet. The pure allowance helper has tested arithmetic/deduplication behaviour, but no production activation baseline or durable order ledger is wired to it.

## Accepted authorization model and remaining setup

The user selected provider-managed authorization on 2026-11-08. The Stockbridge provider owns the registered Flipkart partner application and operates a small HTTPS authorization service for its callback and shared application secret. Every customer authorizes their own seller account; customers do not create or share self-access credentials for this product. The dashboard, Tally access, stock processing and SQLite database remain local. See [ADR 0003](../adr/0003-provider-managed-flipkart-authorization.md).

**Provider registration, hosted authorization and customer connection are not implemented or verified.** Before onboarding the first customer, the provider must complete partner registration and approved application access, deploy the HTTPS callback service, and implement secure authorization handoff and credential lifecycle handling. Keep the shared application secret on the provider service, never in customer installations or portable backups.

Once that flow is delivered, each customer starts connection from their local installation and reviews the provider application's consent on Flipkart using their own seller account. Bind the authorization result to that initiating installation and verify the authenticated seller identity before importing data. Protect per-customer credentials, verify renewal and error recovery, and do not confuse browser sign-in with application authorization. The [customer setup guide](../customer-setup.md#4-connect-the-hingadtyre-flipkart-account) separates the provider prerequisites from the customer steps.

## Publication validation

Before enabling publishing:

1. Complete the provider prerequisites and the intended customer's authorization above. Verify account isolation, installation binding and credential handling with authenticated evidence before using the connection for stock operations.
2. Read authenticated account/location identities and listing details; compare the inspected sample SKU to its API package entries and catalog set evidence.
3. Verify pack evidence for each mapping and source-to-marketplace stock locations. Shipping packages only stand for tyres where one tyre per package is confirmed.
4. Verify approved-order discovery, complete pagination/time coverage, exact listing and location attribution, quantities, repeats and cancellation behaviour.
5. Implement and test activation baselines, durable deduplicated receipts, serialized publication attempts, per-SKU outcomes, uncertainty/read-back recovery and stale-source checks before a reviewed live test.

Sources: [authentication](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration), [listing details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-listing-details), [inventory updates](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsInventoryAPI.html), [shipment details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-shipment-details-by-internal-id).
