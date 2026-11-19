# Flipkart listing and return-package checks in Postman

One collection contains the original three token/listing requests and eight additional return-package research requests. Requests **01-03** and the collection name, **Flipkart - Read-only listing package check**, are unchanged. Exploration adds a new request instead of repurposing a saved one.

Only token copying is automatic: request 01 saves the token used by requests 02-11. There are no pre-request scripts or test assertions. Edit URL placeholders and raw JSON bodies directly, then send the individual request needed. No Tally or Stockbridge startup is needed. Request 09 returned no active handover for the sampled location; request 10 remains prepared and unexecuted because no task identifiers were available.

## Import

Import [the collection](flipkart-listing-package-check.postman_collection.json) into Postman. It uses the portable Collection v2.1 JSON format.

If the collection is already present, keep the existing collection and its original saved requests. Merge or add the missing requests 04-11 into that same collection; do not overwrite an existing request with a different lookup's URL or body. Preserve the current live versions of existing requests from an export of that collection, since local edits may differ from the repository examples. The repository file separately preserves its original three request objects, and appending request 11 preserved requests 01-10 unchanged.

For a new setup, also import [the blank environment template](flipkart-local.postman_environment.template.json), select **Flipkart package check - LOCAL ONLY**, and fill **client_id** and **client_secret** using local values only. Leave **access_token** blank; request 01 fills it. Keep shared/Initial values blank.

**If you already entered credentials, keep that existing environment and update only the collection. Do not replace your filled environment with the blank template.** Old profile or SKU variables can remain; this collection does not use them.

## 1. Get access token

Open **01 - Get access token**. Select the environment containing your credentials, then choose **Send**.

- Method: **GET**
- URL: `https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`
- Authorization: **Basic Auth**, username `{{client_id}}`, password `{{client_secret}}`

After a response, the short response script clears the old **access_token**, then saves a nonempty token only from an HTTP 200 JSON response. Requests 02-11 automatically use that local environment value. You do not need to copy and paste the token.

## 2. Search listings

Open **02 - Search listings**. **Authorization > Bearer Token > Token** is already set to `{{access_token}}`. Keep the same environment selected. In **Body**, use **raw > JSON**:

```json
{
  "filters": {},
  "page_id": null
}
```

Send **POST** `https://api.flipkart.net/sellers/listings/v3/search`. The request includes `Content-Type: application/json` and `Accept: application/json`.

Read the returned **listings** array and copy exact **sku_id** values for the next request. If **has_more** is true, replace `null` in the body with the returned **next_page_id** as a JSON string, then send again. Pagination is manual.

## 3. Get listing details

Open **03 - Get listing details**. Its **Authorization > Bearer Token > Token** also uses `{{access_token}}`. In **Body**, use **raw > JSON**:

```json
{
  "sku_ids": ["12208", "195/55R16_A_Alnac4G_S2"]
}
```

These are example identifiers and are not guaranteed to exist. Replace them directly in the body with up to ten exact seller SKUs from search or Seller Hub, preserving any spaces.

Send **POST** `https://api.flipkart.net/sellers/listings/v3/details`. The request includes `Content-Type: application/json` and `Accept: application/json`. Read each listing under **available** and inspect any **invalid** or **unavailable** entries yourself; no automatic checks run.

Count entries in `available[sku].packages` to inspect shipping packages. This count is not automatically sale pack size. For the agreed tyre rule, confirm one tyre per shipping package for the exact listing before using that count as pack-size evidence. See the [glossary](../GLOSSARY.md).

## 4. Courier returns by return IDs

Open **04 - Courier returns by return IDs**. Replace `REPLACE_WITH_RETURN_ID` directly in this URL with the exact courier-return ID from Seller Hub. For a targeted group, use up to 25 comma-separated return IDs.

```text
GET https://api.flipkart.net/sellers/v2/returns?source=courier_return&returnIds=REPLACE_WITH_RETURN_ID
```

Read `returnItems[]`, including `returnId`, `orderId`, `orderItemId`, `quantity`, `status`, `shipmentStatus`, `trackingId` and `expectedDate`. These describe a return record. A quantity of one or a delivered state does not establish how many physical packages were received.

## 5. Customer returns by return IDs

Open **05 - Customer returns by return IDs**. Replace `REPLACE_WITH_RETURN_ID` with the exact customer-return ID, or up to 25 comma-separated IDs.

```text
GET https://api.flipkart.net/sellers/v2/returns?source=customer_return&returnIds=REPLACE_WITH_RETURN_ID
```

This uses the separate customer-return source. An `expectedDate` is an estimate, and an empty or missing field must remain unknown. One source's successful result does not establish coverage of the other.

## 6. Original packages by order IDs

Open **06 - Original packages by order IDs**. Replace `REPLACE_WITH_ORDER_ID` with an exact order ID from the return response, or comma-separated order IDs.

```text
GET https://api.flipkart.net/sellers/v3/shipments?orderIds=REPLACE_WITH_ORDER_ID
```

Inspect `shipments[].orderItems[].packageIds` and `shipments[].subShipments[].packages`. Join each return through both `orderId` and `orderItemId`; one order can have different return records for separate items of the same SKU. Keep `packageId` and `subShipmentId` scoped to their shipment because the sampled responses reused them across different shipments. Original package structure does not establish which packages are returning.

## 7. Original shipment tracking details

Open **07 - Original shipment tracking details**. Replace `REPLACE_WITH_SHIPMENT_ID` with an original shipment ID from request 06, or comma-separated shipment IDs.

```text
GET https://api.flipkart.net/sellers/v3/shipments/REPLACE_WITH_SHIPMENT_ID
```

Inspect `subShipments[].courierDetails.pickupDetails.trackingId` and `deliveryDetails.trackingId`. Connect them to the package structure using the shipment and sub-shipment identifiers. These are original forward tracking references, not an established reverse-package mapping. This response can also contain buyer details and addresses; retain only the fields needed for research.

## 8. Courier returns by original tracking IDs

Open **08 - Courier returns by original tracking IDs**. Replace `REPLACE_WITH_TRACKING_ID` with an original forward tracking ID from request 07, or up to 25 comma-separated IDs.

```text
GET https://api.flipkart.net/sellers/v2/returns?source=courier_return&trackingIds=REPLACE_WITH_TRACKING_ID
```

This is a diagnostic comparison. The prior live lookup of four original tracking IDs returned **HTTP 400**, `INVALID_RETURN_ID`, `No valid returns found`. That is a possible outcome of this request, not evidence that the saved request is a working reverse join. It also does not establish that no other authorized source exists.

## 9. Active return handovers

Open **09 - Active return handovers**. Replace the seller-location placeholder directly in **Body > raw > JSON**:

```json
{
  "sellerLocationId": "REPLACE_WITH_SELLER_LOCATION_ID",
  "taskType": "RETURN"
}
```

Send **POST** `https://api.flipkart.net/sellers/v3/returns/tasks/initial-load` to inspect the documented active handover sessions for that location. In the documented response, each key under `feDetails` is a field executive's `feId`; that entry contains `task.id`. For request 10, copy the entry's key as `feId` and its `task.id` as `taskId`. Only executives currently starting, scanning or ending a handover are documented to appear; an empty result does not mean there are no pending returns.

On 19 November, one live request returned HTTP 200 with `sellerConfig.enabledFor=DynamicStartEnd` and `feDetails={}`. No active handover or task identifier was returned for that location at that time. This result was observed on screen and transcribed locally; the transcription is not a raw downloaded response.

This request reads session information. It does not generate a code, accept or reject a return, or complete a handover.

## 10. Scanned return shipments

Open **10 - Scanned return shipments**. This request is **prepared only and has not been executed**: request 09 returned no task identifiers for the sampled location. When an existing handover session is returned, use its identifiers rather than inventing them, replacing the placeholders directly in **Body > raw > JSON**:

```json
{
  "taskId": "REPLACE_WITH_TASK_ID",
  "feId": "REPLACE_WITH_FE_ID",
  "pageSize": 20
}
```

Send **POST** `https://api.flipkart.net/sellers/v3/returns/tasks/shipments`. Inspect `scannedShipments[]`, including `trackingId`, `shipmentId`, `status`, `reason` and `scannedAt`. A closed task may return `TASK_CLOSED`. These are handover-session observations; no complete reverse history or original-package mapping has been established.

If the response supplies `nextUrl`, inspect that URL and add a **separate GET request** for the next page, keeping HTTPS, the `api.flipkart.net` host, bearer `{{access_token}}`, `Accept: application/json` and redirects disabled. Keep the saved request 10 as the original POST. Pagination is manual and has not been verified live.

## 11. Shipment lookup using report shipment ID

Open **11 - Shipment lookup using report shipment ID**. This separate request probes the **Shipment ID** column from the Seller Hub returns CSV. Replace `REPLACE_WITH_REPORT_SHIPMENT_ID` directly in the URL with that exact identifier:

```text
GET https://api.flipkart.net/sellers/v3/shipments?shipmentIds=REPLACE_WITH_REPORT_SHIPMENT_ID
```

On 19 November, one probe using an `H-`-prefixed report Shipment ID returned **HTTP 500**, `DEPENDENT_SYSTEM_CALL_FAILED`, in **350 ms**. This is an inconclusive upstream failure. It does not establish that the report identifier is unsupported, valid for this endpoint, or mapped to an original or reverse package. Keep the report identifier separate from the original API shipment IDs until a response or an authoritative contract establishes their relationship.

Request 11 was added by duplicating request 06 and saving a separate request; request 06 still searches by order IDs. No automated retry was added.

Requests 04-11 all use the existing bearer `{{access_token}}` and `Accept: application/json`; requests 09-10 also send `Content-Type: application/json`. The `REPLACE_WITH_...` strings are literal editable placeholders, not environment variables. No new environment values, scripts, test assertions or saved responses are added.

## Tokens and responses

If a token expires or any request returns an authentication error, send request 01 again. A successful response updates the token used by requests **02-11**; renewal itself is manual. If authentication fails, check the selected environment and its local credential values. The URL uses the previously successful `Seller_Api` scope.

Keep credentials, tokens and responses private. Do not export or share filled environments or token response examples. All requests use **api.flipkart.net**, with redirects disabled.

## Verification record

On **2026-11-18**, a separate authorized API check returned HTTP 200 for token access, listing search and listing details. A **previous scripted revision** also returned HTTP 200 for its Postman token request and passed its three response checks. Those checks and its pre-request scripts have now been removed; only the minimal token-copy response script remains.

The simplified token request was also sent in Postman Desktop 12.35.5 on 2026-11-18: HTTP 200, with the interface confirming there are no tests for the request. The complete original three-request workflow has not been verified live. See the [Flipkart validation record](../docs/integration/flipkart-validation.md) for endpoint evidence and remaining application work.

On **2026-11-18/19**, separate exploratory Postman requests returned HTTP 200 for selected courier returns, customer returns, original shipment packages and original shipping details. The original-forward-tracking diagnostic returned HTTP 400 as described above. Those earlier results came from targeted exploratory probes before requests 04-10 were added; they were not a complete return import. See the [return-package research](../docs/integration/flipkart-return-package-research.md) for observed states, identity relationships and remaining limits.

On **2026-11-19**, requests **04-10** were added to the same existing live Postman collection. Its current requests **01-03** were preserved exactly from an export of that live collection, including the user's existing differences from the repository examples. The selected filled environment was left unchanged.

Request **11** was subsequently added as another separate request in that same live collection, without changing requests 01-10 or the environment.

The following saved requests were each sent once on **2026-11-19**:

| Request                                     | Observed result                                                                                                                 | Retained evidence                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **04 - Courier returns by return IDs**      | HTTP 200; seven matching courier-return records.                                                                                | Downloaded response: `.data/verification/six-order-returns-20261119.json`.                                                       |
| **06 - Original packages by order IDs**     | HTTP 200; seven shipments for the six user-supplied orders.                                                                     | Downloaded response: `.data/verification/six-order-shipments-20261119.json`.                                                     |
| **07 - Original shipment tracking details** | HTTP 200; seven original shipments with 28 forward tracking references. None matched the sampled return tracking IDs.           | Sanitized response projection: `.data/verification/six-order-tracking-20261119.json`; buyer details excluded.                    |
| **09 - Active return handovers**            | HTTP 200; `sellerConfig.enabledFor=DynamicStartEnd`, `feDetails={}`. No active handover was returned for the selected location. | Screen-observation transcription: `.data/verification/return-handover-observation-20261119.json`; not a raw downloaded response. |

Request **11 - Shipment lookup using report shipment ID** was also sent once on 19 November. It returned HTTP 500, `DEPENDENT_SYSTEM_CALL_FAILED`, in 350 ms. The selected screen-observed fields are transcribed in `.data/verification/report-shipment-id-probe-20261119.json`; this is not a raw downloaded response. The identifier relationship remains unresolved after this inconclusive failure.

Request **10 - Scanned return shipments** was not sent because no `taskId` or `feId` was available. Its scanning response and pagination remain unverified. These selected API checks do not establish a complete workflow or package-level reverse tracking: the original-package-to-reverse-tracking relationship is still missing. Private evidence stays in the ignored local directory; the repository collection retains placeholders and no customer identifiers.

The expanded repository collection was checked locally for valid JSON, literal request bodies and URL placeholders, shared token references, redirects disabled, and exactly the original token-copy response script with no new scripts or test assertions. Its original three request objects, collection name and blank environment template were compared with the prior repository version and remain unchanged. These structural checks do not establish live handover access or package-level reverse tracking.
