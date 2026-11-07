# HingadTyre customer setup

This repository is developed separately from the customer's Tally computer. Development uses the sample workspace and HTTP fixtures; Tally is not required on the developer's machine. HingadTyre is the first customer, and the seller account observed in Flipkart is **HINGADTYRES**. Keep this customer context for account and listing validation.

The current build supports local review and read-only Tally discovery. It is not ready to enable live marketplace synchronization: Flipkart authorization/import, location verification, durable publishing and production recovery remain delivery work.

## 1. Prepare the customer's computer

- Choose the Windows computer where the customer normally opens Tally and creates bills. Run this local backend on that same computer; the current connector accepts only local addresses.
- Record the Tally product/version, company names, inventory base units and godowns used for marketplace stock. Do not combine companies with similar names.
- Have the customer's Tally administrator available for connection configuration and the authorized HINGADTYRES seller user available for Flipkart authorization.
- For this development build, the technician uses official Node.js 24, installs the locked dependencies and builds the project as described in [README](../README.md). A customer installer and automatic Windows startup are still pending.
- Start the real workspace with `scripts/app.ps1 -Mode Live`. The dashboard is at `http://127.0.0.1:4310`; the separate sample workspace uses port 4311. Never copy the developer's sample database into the customer's live workspace.

## 2. Enable Tally's local connection

On the **customer's** computer:

1. Open TallyPrime and load the intended company.
2. In versions matching the current XML guide, open **F1 (Help) → Settings → Advanced Configuration** and enable the HTTP server. Set the port to **9000**, or record the chosen alternative. Menu labels vary by release; use the installed version's connectivity help if this menu differs.
3. Save the configuration and follow any Tally prompt to restart; reload the company afterward. Initial Tally connectivity changes may need a Tally restart. Later changes to this app's polling intervals do not.
4. Keep this endpoint local. This app does not need a public Tally port or a router port-forward. ODBC is not used by the XML connector.

References: [Tally XML configuration](https://help.tallysolutions.com/xml-integration/), [integration prerequisites](https://help.tallysolutions.com/pre-requisites-for-integrations/), [connectivity and restart guidance](https://help.tallysolutions.com/set-up-for-data-synchronisation/).

## 3. Discover and verify company stock

1. In the app, open **Settings** and enter `http://127.0.0.1:9000/`, replacing 9000 if the customer configured another port. Save settings.
2. Open **Connections → Check & discover companies**. Select the required company in the top bar.
3. Compare several stock items with Tally's stock summary for the same company and date: include positive, zero, negative and newly created items. An unknown value is shown as a dash; it must not be treated as zero.
4. Check that an unmapped item is visible, and that switching companies changes the stock shown without combining balances.
5. Use a customer-approved test entry or an ordinary real transaction to verify changes after billing and receiving stock. Refresh should observe Tally's resulting balance, without writing back to Tally. Do not create a fictitious live bill solely for testing.

This first adapter reads company-wide closing balances. Godown-specific extraction and source-to-marketplace location mapping must be completed before publication. Stable IDs, the company projection and balance-period semantics still need live verification; passing mock tests does not replace these checks.

If discovery fails, inspect **Activity → Diagnostics** and check Tally is open, a company is loaded, and both ports match. A failure preserves old observations and blocks review that requires fresh data. Do not replace an unknown balance with zero to bypass validation.

## 4. Connect the HingadTyre Flipkart account

The HINGADTYRES browser session and inspected listing evidence remain valid setup context. Browser sign-in alone does not authorize this app's API access.

Choose the authorization model according to who operates the integration. Flipkart distinguishes a seller's own self-access app from a third-party vendor/partner managing sellers. For seller-owned use, its documented path is **Manage Profile → Developer Access → Create New Access**. A vendor-operated product uses Flipkart's partner application and seller authorization flow; having one customer does not itself decide the route. Keep seller self-access secrets with the seller instead of sharing them with a third-party provider. [Flipkart's application and authorization guidance](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration).

Proposed application label: **Stockbridge — HingadTyre**. Description: **Read Tally-linked listing inventory and orders, and synchronize reviewed inventory quantities.** The customer must review the actual permissions and terms when authorizing. No application has been registered by this project yet.

Protected credential setup is a remaining implementation step. Do not put secrets in source control, chat, dashboard screenshots or portable backups. After connecting, verify authenticated seller identity and inventory locations before importing mappings.

## 5. Validate listings and packs

- Import the customer's existing listings; mapping must not create Tally stock items or Flipkart products.
- Match the exact stock item, tyre brand/model/dimensions, base unit, listing and destination location.
- Prefer a reliable sellable-set field. Shipping-package count can be used for this customer's one-tyre-per-package practice only after verifying it for the particular listing. SKU endings, package IDs and title digits are not pack evidence.
- Recheck the known example `145/70R12_X3_2_2` / `VTEGYHJKPW2NFEYP`: the browser showed set of two and two packages. Compare the authenticated response. This example does not verify every listing.
- Compare all mappings for mismatches before enabling any positive publication. Missing or conflicting evidence keeps the affected mapping blocked.

## 6. Complete the first live release

The app currently rejects publication requests. Before releasing that capability, finish authenticated order coverage, allowance activation, durable jobs/read-back, godown/location mapping, safe recovery, scheduled backups and customer installation packaging.

Then perform a small customer-reviewed publication and verify the result in Flipkart before expanding scope. Confirm the full shared-stock tyre rule, manual limited-sales behaviour, persistent zero hold and Pause semantics from the [approved architecture](design/architecture.md). In particular, selling one unit of a limited listing must exhaust that listing's allowance even while Tally still has stock; cancellation or purchase must not refill it automatically.

Choose a writable backup folder and verify **Back up now**. The current manual backup is available; scheduled retention and import/restore are pending. Closing the dashboard leaves the running backend active, but closing its terminal stops it until Windows service packaging is implemented. Tally must be open and the relevant company loaded for fresh stock reads.

Record the customer/version, verified company IDs, source and marketplace locations, account identity, mapping verification date, live test outcome, backup destination and support owner. Record identifiers and outcomes, never credentials.
