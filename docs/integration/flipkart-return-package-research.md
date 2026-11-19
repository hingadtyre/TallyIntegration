# Flipkart physical return-package feasibility research

**Investigated 2026-11-18/19 (Asia/Calcutta). Individual courier-return histories were verified for 28 original package tracking numbers across six orders. Physical seller receipt and supported app integration remain unverified. This is not an approved architecture or a delivered Stockbridge capability.**

This document records public API evidence, selected authenticated reads, rendered official carrier tracking histories and the questions needed to assess physical return tracking. It does not approve product behavior, marketplace writes, stock adjustments or an implementation. Current delivered integration behavior remains in [Flipkart validation](flipkart-validation.md); established product vocabulary remains in the [glossary](../../GLOSSARY.md).

## Requirement being investigated

For an order originally dispatched as four physical packages, identify which packages were received on earlier days, which are out for delivery to the seller today, and which remain pending. Show reliable package identifiers, counts and relevant milestones without marking all four received when only part has arrived.

Both courier returns after unsuccessful delivery and customer-initiated returns are in scope. Account locations and time ranges remain product questions. A seller-facing return record, a refund and physical receipt are separate facts.

### Confirmed requirements on 2026-11-19

1. Cover both customer returns and courier/failed-delivery returns, distinguishing them in the dashboard.
2. Prove exact physical package progress before building the dashboard. An aggregate return-status view does not meet the success criterion.
3. Use **Received** only for a package the seller physically received and checked. Display Flipkart's delivery status separately; it cannot automatically establish physical receipt.

These are confirmed product requirements, not approval of an implementation or proof of API feasibility. The mechanism for seller receipt confirmation, data history and reconciliation remains undecided.

On 19 November 2026, the user accepted the current research and Postman changes for commit and push and explicitly put implementation on hold. Preserve these findings for later work; the open questions below are not instructions to begin implementation.

## Public-contract finding

Flipkart documents return records with tracking and shipment status fields, forward package identifiers, and a return-handover scanning workflow. The reviewed contract does not establish a complete mapping from every original physical package to an independently tracked reverse journey.

`returnItems[].shipmentStatus` is explicitly present in the current public schema, but its possible values and semantics are not specified there. The live reads below confirmed `out_for_delivery`, `delivered` and `in_transit` for selected returns. They did not reveal which individual physical packages have those states, or establish that out-for-delivery implies arrival on the current calendar day.

The later official Ekart browser check materially extends that finding: all 28 original package tracking numbers exposed their own RTO histories, including different states and times within one order item. Original outward tracking can therefore reveal courier-return progress for these samples even though it does not match the return API's tracking reference. Browser evidence does not establish a supported tracking API, complete event semantics, customer-return coverage or physical seller receipt.

## Official contracts reviewed

The following are documentation observations, not proof that the seller's credentials, location or fulfillment model can use every operation.

| Contract and primary source                                                                                                                                                | Relevant fields or behavior                                                                                                                                                                                                                                                                                                                                                   | Boundary                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Fetch returns](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/2.0.0/get-returns), `GET /v2/returns`                                                | `returnItems[]` contains `returnId`, `orderId`, `orderItemId`, `shipmentId`, `trackingId`, `courierName`, `quantity`, `status`, `shipmentStatus`, `type`, `createdDate`, `updatedDate`, `approvedOn`, `expectedDate` and `serviceProfile`. Query by date range, location, return IDs or tracking IDs; ID lists have a maximum of 25. Pagination uses `hasMore` and `nextUrl`. | No enumerated `status` or `shipmentStatus`, package array, `packageId`, event history or per-package receipt quantity in this schema.                  |
| [Returns reference](https://seller.flipkart.com/api-docs/order-api-docs/ReturnsRef.html), `GET /v2/returns`                                                                | Documents `source=customer_return` and `source=courier_return`, covering buyer returns and courier-undelivered items; lists created/modified date filters and `locationId`.                                                                                                                                                                                                   | Read both relevant sources. One source's successful response does not establish coverage of the other.                                                 |
| [Shipment lookup](https://seller.flipkart.com/api-docs/order-api-docs/v3/GetByShipmentIds.html), `GET /v3/shipments?orderIds={...}`                                        | Also accepts `shipmentIds` or `orderItemIds`, one selector type per call. Returns `orderItems[].packageIds`, `subShipments[].subShipmentId` and package information including `packageId`, `packageTitle`, `packageSku`.                                                                                                                                                      | Identifies original shipment packaging; no documented reverse milestone per package.                                                                   |
| [Shipping details](https://seller.flipkart.com/api-docs/order-api-docs/v3/GetShipmentDetails.html), `GET /v3/shipments/{shipmentIds}`                                      | `subShipments[].courierDetails.pickupDetails.trackingId` and `deliveryDetails.trackingId`, plus vendor names and `subShipmentId`.                                                                                                                                                                                                                                             | These describe forward pickup from the seller and delivery to the customer. They are not automatically reverse tracking IDs.                           |
| [Return notifications](https://seller.flipkart.com/api-docs/order-api-docs/NotifRef.html#return-created)                                                                   | `return_created`, `return_item_tracking_id_update`, `return_expected_date_changed`, `return_picked_up`, `return_completed`, `return_cancelled`. Creation includes `returnId`, `orderItemId`, item `quantity`, `trackingId`, `shipmentId`, `expectedDate` and `completionDate`.                                                                                                | No documented package-level reverse events or return-out-for-delivery event. The tracking-update event is specifically described for customer returns. |
| [Initial page load](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/initial-page-load), `POST /v3/returns/tasks/initial-load`                        | Request: `sellerLocationId`, `taskType=RETURN`. Response: `sellerConfig.enabledFor`, `feDetails.{feId}` with logistics partner, line of business and `task.id`, `task.status`, `task.createdAt`.                                                                                                                                                                              | Only field executives currently starting, scanning or ending handover appear; excludes those not yet arrived and those whose tasks are complete.       |
| [Shipment scanning](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/shipment-scanning), `POST /v3/returns/tasks/shipments` followed by `GET nextUrl` | Request: `taskId`, `feId`, `pageSize`. `scannedShipments[]`: `trackingId`, `shipmentId`, `status` (`ACCEPTED` or `REJECTED`), `reason`, `scannedAt`, `flyerDetails`, `obdDetails`.                                                                                                                                                                                            | Handover-session evidence, not a general in-transit tracking feed. No `packageId`; `TASK_CLOSED` is a documented error.                                |
| [End OTC details](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/returns-v-3), `POST /v3/returns/otc/end/details`                                   | Part of the actual return handover workflow; completion notification follows verification of the end code.                                                                                                                                                                                                                                                                    | Generating/using handover codes or ending a session is an operational action, not an ordinary research read.                                           |

API paths above omit the production base `https://api.flipkart.net/sellers` where appropriate. Some older references print HTTP URLs; this research does not recommend sending credentials over HTTP.

The current return schema does not document an `orderId` or `orderItemId` query filter. Order IDs can select original shipment details; return records must be selected by documented return/tracking IDs or found in date/source results and matched locally. For the six-order check below, Seller Hub supplied the relevant return IDs. That targeted lookup did not enumerate all API returns or verify pagination. The documented enumeration path follows each response's `nextUrl`; the reviewed contract does not establish default historical coverage or a consistent snapshot across pages.

## Return, quantity and physical package are different

The [official platform concepts](https://seller.flipkart.com/api-docs/FMPlatOverview.html) describe an order item as a product in an order that can have multiple quantities; a shipment groups order items for dispatch. They describe a return ID as corresponding to one quantity of an order item. The API schema also carries a numeric return `quantity`; live behavior must be checked rather than deriving physical package count from return-row count.

The repository's existing tyre rule is that one tyre is shipped per physical package for this seller. The [2026-11-18 listing check](flipkart-validation.md#live-read-only-package-check-on-2026-11-18) found listing configurations containing one, two or four packages. That supports applicable listing pack-size evidence; it does not prove the reverse tracking relationships for a particular dispatched order.

For example, quantity one of a four-tyre listing may mean four physical packages. It must not be rendered as one received package solely because one return record completed. Conversely, several return records must not be counted as several parcels if they share a single physical return consignment.

An original `packageId`, a sub-shipment ID, a carrier tracking ID and a return ID identify different documented objects. Whether one reverse tracking ID represents exactly one physical carton, multiple cartons or a changed/reissued consignment remains unverified.

## Exact unresolved questions

1. **Reverse granularity and access:** Original tracking numbers expose independent RTO histories for the 28 inspected courier-return packages. Can a supported integration retrieve those histories, and how are customer returns, relabelling and replaced tracking numbers linked?
2. **Status meaning:** Which actual `status` and `shipmentStatus` values distinguish in transit, out for delivery to the seller, delivered, rejected, cancelled, lost and administratively completed? Are meanings consistent across both return sources?
3. **Physical receipt:** Does a completion record mean carrier-reported receipt, an accepted handover scan, refund processing, or another business milestone for each relevant flow?
4. **Partial returns:** Can one original order item produce several return IDs, tracking IDs or attempts over time? How are cancelled or replaced return attempts related?
5. **Parcel denominator:** Are the expected parcels all originally dispatched packages, only the packages included in this return, or a separately identified reverse consignment set?
6. **History:** Can earlier handovers be fetched after task closure? The scanning documentation mentions historical pagination but also `TASK_CLOSED`; the accessible period is not established.
7. **Today's deliveries:** The response exposes `out_for_delivery`, but how fresh is it, and what independently establishes arrival on the current calendar day? An `expectedDate` equal to today is an estimate, not evidence that a courier is out for delivery.
8. **Scope and gaps:** Which fulfillment profiles, seller locations and return sources are enabled for this seller? Are empty or missing fields meaningful, delayed or unsupported?
9. **Timing:** What are the carrier display timezone, update delay, history retention and API timestamp/window guarantees? The carrier display timezone is unverified. The scanning schema says milliseconds, while its example `scannedAt` is ten digits; confirm actual units.
10. **Reconciliation:** Which identifiers remain stable across duplicate notifications, rescans, tracking-ID updates and refreshed responses? No implementation rule has been approved.

## Questions that determine the next decision

The three requirements above are settled. The following remaining questions depend on evidence and do not approve an implementation plan.

1. Do the physical return labels preserve the original per-package tracking numbers, or use replacement identifiers?
   - A supplied four-package invoice confirms unique outward labels for a separate order. Compare actual returned labels and seller receipts before selecting a receipt workflow.
2. Which supported integration can supply the independently observed carrier histories?
   - The browser check establishes per-piece RTO visibility for these samples. Establish API access, permitted use and status meanings before implementing automatic refresh; an aggregate return-level view does not satisfy the confirmed requirement.
3. How should the seller confirm an individual package's physical receipt and correct mistakes?
   - Physical receipt is the confirmed meaning of **Received**. Compare available package identities and handover evidence before choosing a confirmation workflow.
4. If automatic identity or receipt evidence is incomplete, should the seller record parcel receipts manually?
   - That would require a separate product decision about identifiers, corrections and ownership; this research does not select it.
5. Which seller locations and historical returns from before connection must be included?
   - Both return types are already in scope. Confirm the remaining scope and retained evidence before proposing synchronization or storage.

## Smallest useful verification

Select one known original order with four physically labelled packages and split arrival dates. Compare read-only return responses for both relevant sources with the seller's records, preserving only sanitized field names, state values, counts and relationships in repository notes.

Use the verified original shipment/sub-shipment/tracking associations and compare physical labels with the per-piece carrier histories. Investigate replacement reverse labels where necessary. Record ambiguous or absent links as unknown instead of inventing matches from array order, SKU suffix or numeric quantity.

If an actual handover is in progress, inspect the documented initial-load and scanned-shipment responses only within authorized read scope. Do not generate codes, accept/reject returns, acknowledge completion or move the handover forward merely to test feasibility.

Compare at least one earlier receipt, one independently confirmed out-for-delivery parcel and one pending parcel. If only some states are available, record that narrower result; it does not establish the whole requirement. Repeated returns and cancellation/reissue cases need later validation if included in scope.

## Live evidence

The investigation used the existing signed-in HINGADTYRES Seller Hub session and the existing local Postman environment. Requests referenced `{{access_token}}`; no credential values were read or exported. The return and shipment API reads were HTTPS GET operations. The 19 November handover check also used the documented read-only initial-load POST, described separately below. Later carrier observations came from rendered official tracking pages, not direct tracking-API calls. No stock, price, return approval, handover code or receipt action was performed. The Stockbridge application and its database were not modified.

### Seller Hub observation

On 18 November, the supplied **Important for Today > Expected Today** view showed zero expected packages, while **All Returns** showed individual rows labelled **Reaching you today**. All Returns did display order IDs, order-item IDs, tracking IDs and return IDs. The missing information in the inspected rows was the independent progress of the physical packages within a multi-package item. The discrepancy is an observation, not a diagnosed Flipkart defect; there was also a transient authentication error toast during tab navigation. The session crossed midnight, so the later refreshed daily counters are not a same-day comparison.

The sampled order had two distinct order items for the same SKU: one return was labelled delivered and the other reaching today. A separate order supplied another reaching-today example. A customer-return row was labelled in transit, delayed beyond 9 November. These labels selected the API probes; they do not prove physical receipt or delivery schedules.

### Earlier authenticated API results

The following table uses aliases instead of customer order and tracking identifiers. Downloaded response evidence is retained under the ignored `.data/verification/` directory, with this investigation's `20261118` filename suffix. The forward-tracking lookup error was observed directly in Postman; no response file was saved for that failed lookup. Shipping details were reduced to shipment and sub-shipment tracking fields after downloading; buyer details and addresses were removed from that local evidence file. No private payloads are included in tracked documentation.

| Read                                                                                   | Observed result                                                                                                                                                                                                                            | What it establishes                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/returns?source=courier_return&returnIds=<three selected IDs>`                 | HTTP 200; three matching records. A: `completed` / `delivered`. B and C: `created` / `out_for_delivery`. All had quantity `1`, a tracking ID, null `shipmentId` and null `expectedDate`; none had a package array or package-level status. | Aggregate courier-return status is accessible with the current seller's token. Quantity and status cannot be converted to physical parcel counts.                                     |
| `GET /v3/shipments?orderIds=<two selected orders>`                                     | HTTP 200; three distinct shipments, one for each sampled order item. Each item referenced four package IDs, with four sub-shipments containing one package each.                                                                           | Original package structure is accessible. This does not establish that every original package is returning.                                                                           |
| `GET /v3/shipments/<three shipment IDs>`                                               | HTTP 200; each shipment had four distinct forward tracking IDs under its sub-shipments. None matched the three sampled return tracking IDs. No independent reverse milestones were present in the inspected sub-shipment data.             | Original package-to-forward-tracking associations can be assembled within each shipment. The reverse join is still missing.                                                           |
| `GET /v2/returns?source=courier_return&trackingIds=<four forward tracking IDs from C>` | HTTP 400, `INVALID_RETURN_ID`, `No valid returns found`.                                                                                                                                                                                   | The documented return lookup did not resolve those four original tracking IDs. This does not prove that no other authorized source exists.                                            |
| `GET /v2/returns?source=customer_return&returnIds=<one selected ID>`                   | HTTP 200; one record, quantity `1`, `created` / `in_transit`, tracking ID present, `shipmentId` null, `expectedDate=2026-11-09T23:59:59`. No package breakdown.                                                                            | Selected customer-return access also works; the date agrees with the UI's overdue estimate. The date lacks an offset, so its timezone cannot be assumed from the adjacent timestamps. |

The three courier returns were fetched twice: the initial screen check and Postman's Download response action, which sends another GET. Each other lookup above was sent once. These were targeted identifier lookups, not a complete return import or pagination test. The targeted responses contained `returnItems` without `hasMore`/`nextUrl`.

### Identity and timing findings

- A and C share an order ID and seller SKU, but have different order-item IDs, forward shipment IDs, return IDs, reverse tracking IDs and return states. Join through both order and order item; grouping solely by order or SKU would merge different returns.
- Their four `packageId` values are identical across the two distinct forward shipments. All three shipments also repeat `SS-1` through `SS-4`. Neither identifier is globally unique in these responses. Preserve shipment scope when associating packages, sub-shipments and forward tracking references.
- Each quantity-one order item has four original packages. Counting quantity one as one physical returned package is demonstrably unsupported for these samples.
- For one `out_for_delivery` return, `updatedDate` was 3 November while the observation was on 18 November. For the other, it was 18 November. These timestamps are not documented per-package scan times and cannot establish that a parcel will arrive today. Both expected dates were null.
- No physical label or seller receipt was independently reconciled. A `delivered` return cannot yet be translated into “all four packages received.”

### Six supplied orders checked on 2026-11-19

The user supplied six multi-package return order IDs. All six appeared within Seller Hub's **All Returns** view, which displayed 32 returns over the selected 90-day period. They corresponded to seven relevant courier-return records. The UI supplied the return IDs used for the targeted API request; neither the UI's 32-row count nor the targeted response establishes a complete API import.

The saved Postman requests `04` (the seven courier return IDs) and `06` (shipments by the six order IDs) were each sent once and returned HTTP 200. Their response bodies are retained locally in the ignored `.data/verification/six-order-returns-20261119.json` and `.data/verification/six-order-shipments-20261119.json` files, respectively. For `06`, the Download Response interaction did not produce the intended file; Save Response To File saved the already displayed response. That file-saving step was not another API request. Actual order, return, shipment and tracking identifiers are excluded from this document.

Request `07` then fetched shipping details for the seven shipment IDs with one HTTPS GET, returning HTTP 200. Its downloaded response is retained as `.data/verification/six-order-tracking-20261119.json`, reduced to order/shipment identity and sub-shipment courier fields; buyer details and other order-item details were removed. This sanitized file establishes the tracking associations below without retaining customer addresses.

| Read                                           | Observed result                                                                                                                                                                                           | Interpretation                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original shipments for six orders              | Seven shipments and seven order items. Every item had quantity one and four package references; every shipment had four sub-shipments with one package each.                                              | The six orders span seven quantity-one items, each configured with four original packages.                                                                                                                          |
| Package identity across those shipments        | 28 package occurrences but only 12 distinct `packageId` strings.                                                                                                                                          | Package IDs repeat across shipments. A global distinct-ID count would undercount the original package occurrences; retain the shipment context. These counts do not identify 28 separately tracked reverse parcels. |
| Seven selected courier returns                 | Four `created` / `out_for_delivery`, two `created` / `in_transit`, and one `completed` / `delivered`. Each had quantity one, null `shipmentId` and null `expectedDate`.                                   | The latest inspected return-level states cover all six supplied orders. They do not provide received, arriving-today or pending counts for the individual physical packages.                                        |
| Forward shipping details for seven shipments   | Four distinct forward tracking IDs per shipment, 28 distinct overall. None matched any of the seven distinct return tracking IDs. No reverse parcel statuses appeared within the inspected sub-shipments. | Forward parcel tracking is available, but matching those tracking IDs does not supply the reverse-package join for these orders.                                                                                    |
| Reverse package mapping in these API responses | No package array, package-level milestone or per-package receipt count in any of the seven return records.                                                                                                | These API responses alone do not expose independent reverse states. The later carrier-browser observations below provide additional evidence.                                                                       |

The user did not supply the individual physical label references or actual receipt dates for these orders. No package was independently confirmed as physically received and checked. In particular, the one Flipkart-reported `delivered` return does not establish that all four associated original packages were physically received.

### Handover initial-load check on 2026-11-19

Postman request `09` sent `POST /sellers/v3/returns/tasks/initial-load` once, with the observed seller location and `taskType=RETURN`. It returned HTTP 200 in 842 ms shortly after midnight local time. The response was observed directly on screen and transcribed to the ignored `.data/verification/return-handover-observation-20261119.json` file. That file explicitly records its observation provenance; it is not a downloaded raw response:

```json
{ "sellerConfig": { "enabledFor": "DynamicStartEnd" }, "feDetails": {} }
```

This establishes access to the initial-load endpoint and the returned location configuration. No active field executive or task was exposed at that observation. The documented endpoint excludes field executives who have not arrived and those whose tasks have completed; an empty `feDetails` therefore does not establish that there were no earlier handovers, no pending returns, or no handover support.

Request `10` (scanned shipments) was not sent because no valid `feId`/`taskId` was returned. No Start/End OTC was generated and no handover was advanced. A populated active handover remains necessary to inspect the scan response's actual identity granularity.

### Individual carrier histories verified on 2026-11-19

The [official Ekart tracking form](https://www.ekartlogistics.in/track-order) opened the carrier's `https://ekartlogistics.com/ekartlogistics-web/shipmenttrack/{AWB}` page. The investigation sequentially inspected rendered page content for all 28 original tracking numbers from the six supplied orders and seven order items. Every original tracking number exposed RTO history. This was browser evidence; no private endpoint or supported tracking API was established.

| Latest raw carrier state and location                          | Original package tracking numbers |
| -------------------------------------------------------------- | --------------------------------: |
| `RtoReceived - PICKUPHUB_MPHUB_UDAI`                           |                                21 |
| `RtoExpected - PICKUPHUB_MPHUB_UDAI`                           |                                 1 |
| `RtoExpected - CentralHub_L_MUMSF2` (Mumbai)                   |                                 2 |
| `return_undelivered_attempted - SATELLITEHUB_ALDF` (Allahabad) |                                 4 |

These are observed carrier-state counts, not seller-received or physically pending package counts. Preserve the raw event, location and displayed time. The carrier display timezone is unverified, and `RtoReceived` at a pickup hub must not be labelled **Received** by the seller.

Two sanitized examples demonstrate independent per-piece progress. `O4` (the fourth order in the user's input sequence) had three packages recorded as hub-received on 7/8 November and one hub-expected on 18 November. `O5` had two hub-received packages dated 11/15 November and two Mumbai hub-expected packages dated 7 November. The observations establish differing histories within the same original item; they do not establish physical receipt or a promised arrival date.

All seven return API tracking references also resolved on the official carrier pages. A return-level reference beginning `FMPN` showed hub receipt while two associated original package references still showed Mumbai hub-expected events. The prefix and this association do not establish a documented master/child identifier model or justify applying the return-level state to every package.

No final seller-delivered event appeared in any of the 28 inspected original-package histories. That absence does not prove that delivery never occurred or that all 28 packages remain physically outstanding. Actual seller receipts have not been reconciled. No actual order or tracking IDs are added here.

The private comparison report is saved at `.data/verification/mps-report/index.html`, with its structured findings at `.data/verification/mps-report/findings.json`. Both files exist locally under the ignored evidence directory. They preserve the browser-observation provenance; they are not a carrier API response or a supported integration implementation.

### Separate invoice and outward-shipment evidence

The user supplied a four-page invoice for a different order, explicitly stating four packages and listing quantity one. Its four distinct outward tracking numbers did not overlap the six return cases above. The original private PDF was unchanged.

Each invoice tracking number resolved on the official carrier site with an outward `Received` event at `CentralHub_UDAI` on 19 November, displayed at 00:12, 00:13, 00:13 and 00:29 respectively. No RTO history was observed for those four numbers. This corroborates unique per-package outward identifiers; it is not evidence about the partial returns or seller receipt.

### Downloaded Seller Hub returns report

Report Centre's generated `off-returns-all-api` download was inspected as UTF-8 CSV despite its `.undefined` extension: 32 data rows and 43 columns. Seven rows matched the six supplied orders. The sanitized local evidence is `.data/verification/seller-hub-returns-report-evidence-20261119.json`; only the matched rows were retained, excluding customer details, prices, comments, invoice fields and actual OTC values.

All seven report tracking references matched the known API return tracking references; none matched the 28 original package tracking numbers. There were no package, sub-shipment or parcel columns. The report repeated the four out-for-delivery, two in-transit and one delivered states, with six `Open` and one `Closed` completion statuses. It therefore adds return-level evidence without resolving the per-package receipt count.

Additional fields included `Shipment ID`, `Out For Delivery Date`, `Completed Date`, `Completion Status`, `Delivery Proof Time` and `Delivery Proof OTC`. The closed row had completion and proof dates of 18 November 2026 and a nonempty, non-placeholder OTC; the code value was neither retained in the sanitized evidence nor reproduced here. This is recorded return-level completion proof, not independent evidence that the seller physically checked every package. All seven `Bag Tracking ID` fields were empty; the closed row's flyer status was `skipped`, with `DUMMY_FLYER` as the actual flyer and no captured flyer.

The four open out-for-delivery rows had recorded out-for-delivery dates of 21 October and 11, 12 and 13 November 2026. Those dates do not support interpreting the state as a new delivery attempt on 19 November.

All seven report `Shipment ID` values used an `H-` prefix and differed from the original UUID-shaped shipment IDs. Their mapping is unproven. The [documented shipment lookup](https://flipkart.github.io/fk-api-platform-docs/docs/mp-api_versioned/get-shipment-details-by-internal-id) accepts `shipmentIds` as comma-separated strings, up to 100, without a published UUID-only pattern; it does not identify the report's `H-` format as accepted.

Postman request `11`, saved separately from the unchanged request `06`, tested one observed report shipment ID with `GET /sellers/v3/shipments?shipmentIds={reportShipmentId}`. It was sent once and returned HTTP 500 in 350 ms with `DEPENDENT_SYSTEM_CALL_FAILED` and message `A call to dependent system failed. Please retry after some time`. No package mapping was returned and no retry was made. This dependency failure does not establish whether report shipment IDs are accepted, invalid or unsupported; the lookup avenue remains unresolved. The private evidence `.data/verification/report-shipment-id-probe-20261119.json` is a selected-field transcription of the visible Postman response, not a downloaded raw response.

### Supported integration still to establish

The [official Ekart FAQ](https://www.ekartlogistics.in/faq) says API documentation is supplied for integration. No public tracking schema or authoritative dictionary for the observed RTO event names was established. The next contract check must cover existing Flipkart-issued AWBs, RTO history, customer-return linkage, final delivery proof, authentication, update limits and permitted use by the customer's own app.

Ekart's published [website terms](https://www.ekartlogistics.in/terms-and-conditions), section 1.2, restrict scraping and automated monitoring; sections 12 and 13 address recipient tracking access and reuse of website material. These are published conditions, not a legal conclusion. The browser's working tracking page is not itself an approved production automation contract. Obtain the applicable supported integration terms before choosing a recurring website-based approach.

### Feasibility boundary and next evidence

The combined evidence now establishes original per-package identity and independently differing courier-return histories for the inspected six orders. The remaining gaps are supported automated access, reliable event interpretation, customer-return validation and seller-confirmed receipt. Carrier hub-state counts cannot yet become defensible counts of physical packages received previously, arriving today or still pending. No product build, fallback view or manual receipt workflow has been approved.

Next reconcile actual returned labels and receipt dates against these observed per-package histories, resolve the report shipment-ID mapping after the inconclusive dependency failure or through platform clarification, obtain the supported carrier integration contract, and test customer-return examples. Initial-load access is verified, but a populated handover and the scan endpoint remain untested. The delivery-agent application, Seller Hub's private network responses, direct carrier APIs, notifications and closed-task history were not inspected. The carrier website and the downloaded Seller Hub returns report were inspected as described above.

### Current application gap

The existing application has tokens and listing transport but no return ingestion, package-return model or return dashboard. Its known token-scope and listing-discovery compatibility gaps remain as recorded in [Flipkart validation](flipkart-validation.md#live-read-only-package-check-on-2026-11-18); this investigation did not change them. No ADR is added because no lasting architecture trade-off has been decided.

## Validation and remaining work

The public sources were read on 2026-11-18/19. The three six-order response files were inspected for aggregate counts, fields, identity reuse and forward/return tracking intersections; the handover file is a separately identified screen transcription. Later carrier evidence comprises rendered observations of 28 original return-case tracking numbers, seven return-level references and four separate invoice tracking numbers. The sanitized returns-report evidence was checked for row/column coverage, identifier comparisons, dates and proof-presence metadata; the single report shipment-ID lookup is recorded from a separate screen transcription. Relative document links and Markdown structure are checked as documentation work. No return API implementation, database change, automated job, marketplace mutation or product acceptance test is included in this research.

Before any capability claim or design approval, resolve the identity, status, receipt and historical-coverage questions against representative live evidence and the user's required meaning of package receipt.
