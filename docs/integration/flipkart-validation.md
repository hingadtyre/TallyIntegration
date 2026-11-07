# Flipkart connection status

The seller browser displayed HINGADTYRES. One set-of-two listing was matched to two shipping packages during the design interview. No app registration, API credentials, authenticated listing import, order import or live inventory write has been completed.

Public Orbit discovery on 2026-11-07 located listing inventory/search and shipment lookup candidates. Integrating the shipment candidate returned a partial fit: bearer-authenticated `GET /sellers/v3/shipments` needs known shipment/order/order-item identifiers, and does not establish listing stock or complete order discovery. Some discovery listing URLs omitted the `/sellers` prefix; official API documentation remains authoritative rather than copying the search summary blindly.

The local application therefore has no marketplace transport or publishing implementation yet. The pure allowance helper has tested arithmetic/deduplication behaviour, but no production activation baseline or durable order ledger is wired to it.

Before enabling publishing:

1. Confirm the operating model and register/authorize the applicable application: seller-owned use can use self-access, whereas a third-party provider uses Flipkart's partner/seller-authorization flow. Having one customer does not by itself select the route. Confirm new security-sensitive access and terms if presented. Store credentials using protected machine storage, never in the browser UI or portable database backup.
2. Read authenticated account/location identities and listing details; compare the inspected sample SKU to its API package entries and catalog set evidence.
3. Verify pack evidence for each mapping and source-to-marketplace stock locations. Shipping packages only stand for tyres where one tyre per package is confirmed.
4. Verify approved-order discovery, complete pagination/time coverage, exact listing and location attribution, quantities, repeats and cancellation behaviour.
5. Implement and test activation baselines, durable deduplicated receipts, serialized publication attempts, per-SKU outcomes, uncertainty/read-back recovery and stale-source checks before a reviewed live test.

Sources: [authentication](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration), [listing details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-listing-details), [inventory updates](https://seller.flipkart.com/api-docs/listing-api-docs/v3/UpdateListingsInventoryAPI.html), [shipment details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-shipment-details-by-internal-id).
