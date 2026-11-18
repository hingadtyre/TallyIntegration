# Flipkart listing package check in Postman

Three read-only requests get a token, search listings and read listing details. Only token copying is automatic: one response script saves the token for both listing requests. There are no pre-request scripts or test assertions. Edit request bodies directly as raw JSON. No Tally or Stockbridge startup is needed.

## Import

Import [the collection](flipkart-listing-package-check.postman_collection.json) into Postman. It uses the portable Collection v2.1 JSON format.

For a new setup, also import [the blank environment template](flipkart-local.postman_environment.template.json), select **Flipkart package check - LOCAL ONLY**, and fill **client_id** and **client_secret** using local values only. Leave **access_token** blank; request 01 fills it. Keep shared/Initial values blank.

**If you already entered credentials, keep that existing environment and update only the collection. Do not replace your filled environment with the blank template.** Old profile or SKU variables can remain; this collection does not use them.

## 1. Get access token

Open **01 - Get access token**. Select the environment containing your credentials, then choose **Send**.

- Method: **GET**
- URL: `https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`
- Authorization: **Basic Auth**, username `{{client_id}}`, password `{{client_secret}}`

After a response, the short response script clears the old **access_token**, then saves a nonempty token only from an HTTP 200 JSON response. Both listing requests automatically use that local environment value. You do not need to copy and paste the token.

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

## Tokens and responses

If a token expires or a listing request returns an authentication error, send request 01 again. A successful response updates the token used by **both** listing requests; renewal itself is manual. If authentication fails, check the selected environment and its local credential values. The URL uses the previously successful `Seller_Api` scope.

Keep credentials, tokens and responses private. Do not export or share filled environments or token response examples. All requests use **api.flipkart.net**, with redirects disabled.

## Verification record

On **2026-11-18**, a separate authorized API check returned HTTP 200 for token access, listing search and listing details. A **previous scripted revision** also returned HTTP 200 for its Postman token request and passed its three response checks. Those checks and its pre-request scripts have now been removed; only the minimal token-copy response script remains.

The current files were checked for valid JSON, literal request bodies, shared token references and exactly one response script with no pre-request scripts or test assertions. The simplified token request was also sent in Postman Desktop 12.35.5 on 2026-11-18: HTTP 200, with the interface confirming there are no tests for the request. The complete current three-request workflow has not been verified live. See the [Flipkart validation record](../docs/integration/flipkart-validation.md) for endpoint evidence and remaining application work.
