# Stockbridge: customer setup and daily use

**Version 0.1.0 pilot. Guide updated on 2026-11-20.**

Stockbridge reads a Tally company's stock and shows it in **Inventory**. Map a Flipkart listing to a Tally item and confirm how many physical units make one sale. You can then publish a reviewed quantity or enable automatic updates for that company. In the live workspace, both actions can change stock on Flipkart. Sample mode uses local sample data.

Sign in to the intended Flipkart account and use its own application credentials in Stockbridge. On a fresh workspace, choose **Marketplaces > Add account**. **Verify and save** checks access and attempts a listing import. A successful nonempty import verifies listing ownership. Flipkart can return listings without a separate seller ID.

On a fresh live setup, the selectors show **No company connected** and, once Inventory is available, **No seller account** until you connect your own data. Tally discovery supplies company names. Adding a marketplace account supplies its seller label. Older unused placeholder labels are hidden; genuine saved company/account names and existing listings are retained. The packaged **Start Stockbridge.cmd** opens the live workspace. A separately supplied **Sample workspace** uses generic examples and simulates publication.

## Before you start

Arrange a setup time with the person providing Stockbridge. Have these available:

- The Windows computer on which you normally run Tally and create bills. Use that same computer for Tally inventory work; marketplace-only management does not require Tally to be running. The package is for **Windows x64**, not a phone, Mac or Windows ARM installation.
- Your normal Windows login and access to the intended Tally company. Ask your Tally administrator to help if you cannot change its connectivity settings.
- The Stockbridge pilot ZIP supplied by the provider, its version/checksum information, and the provider's support contact. A ZIP is a folder compressed into one download. Do not download a different package because its name looks similar.
- A browser such as the one you normally use for Flipkart. You do not need Git, Node.js, npm, a database installer or programming knowledge for the packaged pilot.
- A place to keep backup copies. Your technician can help choose a folder on a separate drive for protection against failure of the computer's main drive.

Do not send Tally or Flipkart passwords, API keys or application secrets in chat or email. Stockbridge does not ask for your Flipkart seller password. The optional connection below uses separate API credentials created in your own seller account and entered directly into the local Stockbridge form.

## 1. Extract the application

1. Save the supplied file whose name starts with **Stockbridge-Pilot** and ends with **.zip**.
2. Open **File Explorer**, usually the yellow folder icon on the Windows taskbar. Open the folder containing that download.
3. Right-click the ZIP and choose **Extract All**. Select a folder you intend to keep and choose **Extract**. Wait until extraction finishes.
4. Open the extracted Stockbridge folder. You should see **Start Stockbridge.cmd**, **Stop Stockbridge.cmd**, **Stockbridge Status.cmd**, **Open Data Folder.cmd**, and **Read Me.html**, together with application folders.
5. Double-click **Read Me.html** to open this guide in your browser. It works without internet after extraction, although links to external help pages require internet.

**Do not start the application from inside the ZIP.** Do not copy just the Start file to another folder; it needs the other files beside it. You can create a desktop shortcut to the Start file instead. Keep the whole extracted folder until your provider guides you through an update.

This is a portable pilot, not a signed Windows installer. If Windows or your organization's security software blocks it, ask your provider or IT contact to verify the supplied file. Do not disable security software to get past the message. The provider must resolve distribution/signing requirements before a routine customer release.

## 2. Open Tally and enable its local connection

This lets Stockbridge ask Tally for stock. It does not let Stockbridge create or edit bills.

1. Open Tally on this computer.
2. Load the company whose stock you want to review. Check its name carefully; similarly named companies can contain different stock.
3. In current TallyPrime guidance, open **F1 (Help) > Settings > Connectivity > Client/Server Configuration**.
4. Choose **HTTP Server** or **Both** and note the port number. Use **9000** if it is available. A port is simply the connection number that both applications must agree on.
5. Save the setting. If Tally asks you to restart, follow its prompt, reopen Tally and load the company again.
6. Keep Tally open during the next steps.

Your Tally release may have different labels. Another documented route is **Alt+Z (Exchange) > Configure > Client/Server Configuration**. Older XML guidance uses **Advanced Configuration**. If you cannot find these options, tell your technician the Tally release shown in **F1 > About** instead of changing unrelated settings. Where present, **F1 > About > Connectivity** shows the listening port.

Only the **local HTTP connection** is needed. Do not create a public tunnel, change router port-forwarding, enable Tally.NET synchronization, or configure ODBC for this app. Your normal Tally backup remains necessary; Stockbridge's database backup is not a backup of the accounting company.

Official references: [Tally's current connectivity instructions](https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/), [alternative menu and restart instructions](https://help.tallysolutions.com/set-up-for-data-synchronisation/), [older XML settings](https://help.tallysolutions.com/xml-integration/). Those pages also describe other integration arrangements; follow only the local-connection steps above for Stockbridge.

## 3. Start Stockbridge

1. In the extracted application folder, double-click **Start Stockbridge.cmd**.
2. Allow a short time for startup. The application opens your browser at **http://127.0.0.1:4310**.
3. If the browser does not open automatically, enter that complete address in its address bar, not a web search box.
4. Check the workspace name and mode. **Publish** in Inventory, **Enable automatic updates** and **Apply** in a live marketplace editor can change Flipkart.

The address **127.0.0.1** means this computer. It is not a public website. Open it on the same computer as the application; it will not open the same dashboard on a phone or another PC.

The Start window may close after startup. Stockbridge continues running in the background. Closing the browser does not stop it. Starting it a second time opens the existing instance rather than starting a second owner of the same database.

If Start reports a problem, leave the message visible and use the troubleshooting table below. Do not delete the data folder to try to repair startup.

## 4. Connect to the correct Tally company

1. In Stockbridge, select **Settings** in the left navigation.
2. Find the Tally connection address. If Tally uses port 9000, enter **http://127.0.0.1:9000/**. If your Tally port is different, change only that number to the one you recorded.
3. Select **Save settings**. Confirm the saved message. A failed save leaves the previous settings in place.
4. Select **Connections**, then **Check & discover companies**.
5. Wait for the result. Successful discovery shows **Connected**, the check time and the companies found. A red error or **Offline** means the check did not succeed, even if older stock is still visible.
6. Use the company selector at the top to choose the intended company, then open **Inventory**.

Keep the Tally port and dashboard port distinct: **9000** is normally Tally; **4310** is Stockbridge's browser dashboard. Putting 4310 in the Tally address is not a connection fix.

More than one company can be loaded in Tally. Stockbridge keeps their records separate; the top selector decides which company you see. It does not combine their quantities. Background checks can read the loaded companies, regardless of which one is currently displayed.

Changing the Tally address makes all previously read Tally observations require a fresh read. Refreshing only one company does not make another company's old-source stock current.

## 5. Check the stock before relying on the display

Complete this with your Tally administrator or Stockbridge provider during first setup:

1. Compare the selected company name with Tally.
2. Compare several familiar items with the corresponding Tally stock summary, using the **same date/reporting period and units**.
3. Include an item with stock, an item with zero, and a newly created item. If the business uses negative balances or different units, include those too.
4. Confirm a Tally item appears even if it has no Flipkart listing. Imported marketplace listings can exist without a Tally mapping. A listing import does not verify a pack size or create a stock mapping.
5. If another company is loaded, switch companies and confirm its quantities stay separate.
6. After an ordinary sale is billed in Tally, use **Refresh Tally** and check the resulting quantity. Do the same after an ordinary stock receipt when practical. Do not create a fictitious live bill just to test the app.
7. Ask the provider to record the verified Tally release, company/item identities, units, reporting period and results. Differences must be investigated before the display is accepted.

**This version reads company-wide closing balances.** A godown is a Tally stock location. Confirm the mapping only when this entire item's balance can fulfil orders at the selected Flipkart location. A business that needs separate godown balances for different warehouses must first agree how to allocate that stock.

A dash **-** means the quantity is unknown or unavailable, not zero. If a read fails, the last saved quantity can remain visible. Check the connection message and observation time before interpreting it as current stock. The app must not invent zero to hide a failed read.

Brands are not extracted by the current live Tally reader. Brand filters become useful only when reliable brand information is available; a blank brand is not a missing stock item.

## Optional: verify seller-owned Flipkart API access

Use an approved **Self Access** application registered by your business for its own seller account. Confirm with your provider that this access arrangement applies to your installation. See [Flipkart's access rules](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration).

1. Sign into the intended seller in Flipkart and open **Profile > Developer Access > Self Access**. Check for an existing application before creating another.
2. If you need to register, supply the application details for your business and the public website requested in Seller Hub. Check the status there. If it shows **Pending**, wait for Flipkart approval.
3. Obtain usable **Application ID** and **Application Secret** from Flipkart when access is approved. These are separate from the seller password. Enter them directly into Stockbridge; do not send them to support.

## Manage marketplace accounts and listings

You can use this view without connecting or selecting a Tally company.

1. Open **Marketplaces > Add account**, choose **Flipkart**, and enter an account name, Application ID and Application Secret. Flipkart is the currently supported choice.
2. Choose **Verify and save** to check access, protect the credentials and import this account's listings. **Save without verification** stores the credentials locally. Choose **Check connection** later to verify access and attempt the import. Each account has independent credentials.
3. Choose **Open listings** and check the listings and last successful refresh. If the import failed, the account tile explains why. Choose **Refresh listings** in the listings view to retry. When Flipkart omits the seller ID, a successful nonempty import shows **Listing ownership verified · Flipkart did not supply a seller ID**.
4. Review the listings, including those without Tally mappings. Search by title, SKU or product reference, or filter by status across the complete last successful import. If a search, filter or page fails to load, choose **Retry listings** to load that view. If a Flipkart refresh fails, earlier observations stay available. Check their age and choose **Retry refresh** to request a fresh import.
5. Use **Add account** for a different seller. Replacing one tile's credentials with another seller's credentials does not transfer the tile's seller binding. An empty account cannot yet establish a new seller identity.
6. On an account tile, use **Check connection**, **Update credentials** or **Disconnect locally** as needed. Local disconnect removes this account's saved access. After a restart or credential change, wait for a successful catalog refresh or choose **Refresh listings** before making a stock change.

Credentials are protected for the current Windows user outside the database and its backups. A new computer or Windows login needs connection setup again. Tokens are held only while Stockbridge runs. Sample accounts use no credentials and make no Flipkart requests. If a previously saved listing disappears from a successful refresh, its stock becomes unavailable and editing is blocked; its identity and unfinished update history remain for review.

### How imported listings relate to Inventory

The four totals at the top of **Inventory** also select what appears below. Choose **Low physical stock** to check items at or below their threshold, or **Saved proposals** to find drafts. Choose **Tally stock items** to return to all items. Search, brand and pack filters also apply. Selected listings keep priority for bulk actions, even when hidden by another view. Use **Clear selection** to act on the current filtered listings.

To set stock aside, enter a quantity in **Keep back from marketplaces** on the Tally item's own row. Use its Tally unit, even when a marketplace listing sells a pair or a larger set. As you edit, Stockbridge checks unbilled orders. **After keep-back** shows the balance after the keep-back alone. **Available for marketplaces** shows the balance after verified order reservations as well. Choose **Save** to apply the setting across the item's mapped listings. Company sync uses it on the next eligible update. With sync off you can calculate and review proposals. Enter **0** to release the stock.

For example, eight tyres with two kept back and one already reserved leave five tyres, enough for two pairs. If you enabled the Flipkart tyre minimum, the pair listing can advertise five while at least one complete pair remains. If you manually enter more packs than can be supplied after the keep-back, Marketplaces and Inventory review both ask you to confirm that quantity for the pickup location. A normally calculated tyre minimum follows the setting you already enabled.

1. In **Inventory**, select your Tally company and Flipkart seller account. Choose **Map listing** on the Tally item. In **Flipkart listing**, type part of the seller SKU or product title, or paste the FSN (Flipkart product ID) or Flipkart listing ID. Exact identifiers appear first. A similar name or model can suggest a listing. Check the product, variant and warehouse. Click the matching listing or use the arrow keys and press **Enter**. Press **Escape** to dismiss the list and keep your current choice. If Flipkart has not reported a location for the SKU, select the seller’s pickup location or choose **Choose later** and save the mapping. **Edit Set of** lets you complete a pending pickup choice. The choices come from enabled locations in the selected seller’s imported catalogue. If none appear, check the registered pickup location in Seller Hub and refresh the account in Marketplaces. Use **Calculate** and **Review changes** to publish to the confirmed location. Stockbridge checks the quantity returned by Flipkart after the update.
2. Under **Set of**, choose **Use package count** only when the number of shipping packages equals the number of physical Tally units sold together. For a two-tyre sale shipped in one parcel, choose **Enter a number** and enter **2**. These choices work for every category. The SKU and title do not determine the number.
3. Confirm that this item's entire company balance supplies this location. For an eligible tyre listing, you may also select **Apply the Flipkart tyre minimum of 5**. With that option a positive number of complete sets advertises at least five. With zero complete sets, it advertises zero. Each mapped listing draws on the same physical balance, so check low stock carefully when several listings use one item.
4. Choose **Save mapping**. The listing row now shows its **Set of** value and source. Choose the pencil in that cell to edit it, then **Save Set of**. The same workspace restores your mapping and choice when Stockbridge restarts.

With **Set of 2** and the tyre minimum switched off, 13 physical units give six complete sets, two units give one set, and one unit gives zero.

### Publish stock from Inventory

1. Check the company, seller account and listing destinations. Select the rows to review and choose **Calculate**. If some listings need attention, the result lists each SKU and location. **Fix Set of** opens that listing’s pack setting. **Review ready drafts** opens the successful rows. An existing manual draft keeps its quantity. Saving a corrected Set of recalculates that row and updates the result. To propose a different quantity, edit **Proposed stock** and save it. An edited positive quantity can use stock you kept back if you confirm the override during review. The usual Inventory limit for that listing before keep-back still applies.
2. Choose **Review changes**. For an edited positive quantity on an **Auto** listing, choose **Update once**. This publishes the reviewed quantity and keeps the Auto policy. The next change to the item's Tally stock can replace it once automatic updates are enabled. The separate **Allow this many more sales** option needs order tracking and is unavailable for live listings. If you enter `0` yourself and choose **Publish**, Stockbridge pauses Tally sync for that listing at that location, even if Flipkart already shows zero. If **Calculate** produces zero because there are too few units for a set, sync stays on and a later restock can bring the listing back.
3. Check the observed and proposed quantities for each destination. The quantities in **Review changes** stay as shown when you opened it. Choose **Publish** for the indicated number of eligible listings. Stockbridge checks each row again, even if the review has only been open a few seconds.
4. Read each result. For example, if you reviewed 5 and another unbilled order brings the calculation down to 4, Stockbridge skips that row. Review the new quantity from the results if you want to send it now. Other eligible rows can still publish. **Confirmed** means Flipkart's quantity matched on readback. **Unchanged** means it already matched. A blocked, failed or uncertain result explains what happened. For an uncertain result, check the listing in **Marketplaces** before attempting another update.

Typing a quantity and choosing **Save draft** saves it as your manual proposal, even if it matches the calculated number. Saving leaves the listing’s sync setting in place. Save or discard any unsaved edits before opening Review. If a filter or collapsed item hides what you typed, **Show unsaved edits** takes you back to the first hidden field. **Discard edit** restores the latest saved proposal.

### Use automatic stock updates

Open the automatic updates preview in **Inventory**. It covers every seller account mapped to the selected Tally company, including accounts hidden by your filter. Compare the observed and expected quantity for each seller, SKU and location. Paused listings stay paused. Waiting listings can start automatically once their checks pass. Newly verified mappings also follow the company setting.

To check one result first, choose **Try one listing**, review the location and calculated quantity, then approve that listing’s update. In live mode this can change stock on Flipkart. When the two quantities already match, Stockbridge reports that result without sending stock. The trial preserves your drafts, stock policy and company setting. Open a fresh preview to enable automatic updates for the company.

A Tally stock change recalculates eligible listings across all its participating seller accounts. With order coverage set up, Stockbridge also checks for new Flipkart sales on the **Marketplace stock** schedule. If two tyres supply both singles and pairs, selling one single can set the pair listing to zero as soon as Stockbridge verifies the sale. An order-triggered check only lowers stock. Repeated checks and billing the same sale count it once. **Refresh Tally** requests a check now.

Stockbridge fills in the first **Proposed** quantity when it verifies an order and checks it against Tally. This works whether you mapped the listing before or after the order arrived. Any unbilled units reduce the balance available to all listings for the same Tally item. Stockbridge refreshes calculated proposals as stock, keep-back, listing settings or reservations change. You can see the proposal with company sync off or a listing paused. A quantity you enter yourself stays yours to review. If an order is waiting for verification, saving a zero draft keeps that check pending.

For example, suppose Tally shows 8 tyres, **Keep back** is 0 and a customer orders one **Set of 4**. Before you enter the bill, 4 tyres are reserved and 4 are available, enough for one more set. With the tyre minimum off, the proposed stock is **1**. If Flipkart shows 5 and company sync is on, an eligible, unpaused listing can drop to 1. With the tyre minimum on, the proposed stock is **5** and a listing already showing 5 needs no update. When you bill the sale, Tally falls to 4 and the four reserved tyres are released. One complete set is still available.

Before Stockbridge can publish a calculated quantity above zero to Flipkart, [set the starting stock for automatic updates](#set-the-starting-stock-for-automatic-updates). If the verified number of listing units differs from the number reviewed, an eligible automatic update can still send the latest stock. With company sync off or the listing paused, the new proposal is available for manual review.

Inventory and the marketplace stock editor show whether the company is syncing and whether a listing is paused or waiting. Flipkart’s listing status describes the offer on Flipkart. If one loaded Tally company fails a stock check, its last successful check remains visible and its stock waits for verification. Other successfully read companies can continue. If Tally itself cannot be reached, all companies wait.

To stop automatic updates for a company, choose **Turn off automatic updates**. To pause one destination, choose **Pause automation** on its row. A lock and **Tally sync paused** identify that location. Choose **Resume sync** to unlock that location and replace its saved draft with a fresh **Proposed stock** calculation. If the calculation needs more information, the quantity stays blank and the row explains what to check. After fixing the cause, use **Calculate** for that listing.

The **Auto** badge means the normal stock calculation applies. A finite sales allowance appears on listings that have one. **Queued for a stock check** means Stockbridge will compare the calculated stock with the marketplace observation on the next eligible sync. The comparison can result in a stock update or confirm that Flipkart already has the right quantity. With company updates off, you can still see the proposal. Automatic publication waits until the company’s updates are enabled. When you upgrade, listings previously marked **Kept out of stock** appear as **Tally sync paused**. Their current Flipkart quantity stays in place during the upgrade.

On each successful catalog refresh, Stockbridge compares the latest shipping package count with the saved value. If a package-based mapping changes, Inventory shows both values and pauses publication for that mapping. Open **Set of** and accept the new count, or keep the previous number as a custom value. If the count is unavailable, refresh the account or explicitly enter a number. A custom Set of keeps its value when the shipping count changes.

### Apply a stock or price change

1. Open the pencil beside **Stock**, **MRP** or **Selling price** on the intended listing. For stock, check the exact location shown; changing one location does not copy the quantity to other warehouses.
2. Enter a whole stock quantity or whole-rupee price. Stock accepts 0 to 5,000 in this view. Prices must be positive, and selling price cannot exceed MRP. Title and SKU are display-only.
3. A manual stock edit to a Tally-mapped listing pauses sync for that seller’s listing at the selected warehouse. If you set Flipkart stock to 2, a customer buying one can still reduce it to 1. If your shop sells out in Tally, Stockbridge skips the automatic update to zero while the location is locked. Use **Resume sync** beside the lock when Stockbridge should update it again.
4. Live **Limited sales** blocks positive stock until order reconciliation is available. To remove the constraint deliberately, select **Change stock policy**, read the effect and choose **Confirm automatic policy**. For an already paused location, use **Resume sync** when you want it to follow Tally again. Review the quantity and use Apply separately. Keeping the policy permits only edits that satisfy it.
5. Choose **Apply and pause sync** for mapped stock or **Apply** for an already paused location, unmapped stock or a price. If Stockbridge blocks the edit before submission, check its message and review the current value. Once Stockbridge submits a mapped stock edit, the location stays paused even if Flipkart rejects the quantity or the result is uncertain.
6. Wait for **Updated**. If a stock update shows **Result uncertain**, use **Check result** to read Flipkart again. When Stockbridge knows that the previous request completed or was never sent, choose **Review current stock**. Recovery needs a verified Inventory mapping and confirmed order coverage for that Tally company. Compare the current Flipkart quantity with the quantity calculated from Tally and covered orders. **Approve and keep** closes the review without a write. **Approve and send** requests the new quantity. An expired review or changed figures require a fresh review. The earlier attempt stays in history.
7. If the submission reply was lost and Stockbridge has no evidence that the request finished, the listing remains blocked. For example, seeing four tyres after requesting five can mean that another tyre sold. Contact support if the uncertainty persists. Elapsed time and the listing quantity alone cannot establish that an old request has finished.
8. Use **Open in Flipkart** for settlement. Stockbridge does not calculate or edit settlement, and does not present effective selling price as settlement.

Before first live publication, arrange a controlled, seller-authorized stock update with the provider and confirm its readback. After a restart, unfinished attempts remain visible as uncertain and require a check before retrying.

### Match recent Flipkart orders to Tally sales bills

Stockbridge can reserve a verified standard or self-ship order as soon as Flipkart reports it as approved, including while it is waiting for dispatch. An **Upcoming** label in Seller Hub alone is insufficient. Stockbridge checks the order details and can count a confirmed forward order even when Flipkart omits the courier-return flag before dispatch. Held orders, replacements, returns and conflicting order details require review. To investigate a mapped listing, open **Listings from orders**, expand **Previously mapped listings** and choose **Check orders** for the SKU. Under **Order item details**, use the order item ID to check the reported status in Seller Hub. A matching sales bill shows that you recorded the sale in Tally. Set up matching separately for each Tally company and Flipkart seller account.

1. Open **Order matching**, select your Tally company at the top and choose the **Flipkart seller account**. Load the company in Tally and verify the account and its listings before the first live preview.
2. Open **Sales bill ledger** and type any part of the dedicated Flipkart ledger name used for the party on the sales bill or for sales on its stock lines. Click a matching ledger, or use the arrow keys and press **Enter**. Press **Escape** or click outside to keep your previous selection. Choose the bill field where you enter the Flipkart reference and the type of reference you enter. Choose **I match bills manually** if you keep the reference elsewhere or omit it.
3. Choose **Today in India**, **Last 7 days** or **Last 30 days**, then **Preview matches**. The dates use the Indian calendar. Check a known Flipkart order item against its Tally bill, mapped item and units. **Confirm billing setup** saves your choices. An empty preview can still be saved for future use.
4. In later sessions choose **Refresh preview** to check the period again. Select **Show unresolved only** to work through the remaining order items. When several bills are possible, verify the order, item, bill number and date before choosing **Confirm bill match**. The confirmed item drops out of the filtered list and the filter stays selected. **Release manual match** removes your confirmation if you chose the wrong bill.

**Available stock preview** shows the selected seller and period. Once tracking starts, **Listings from orders** uses saved orders from the confirmed date. An older sale can still appear in the billing preview without needing a mapping. Matching a saved order can find an exact bill outside the preview period. To confirm an ambiguous bill manually, the order must still be within the 30-day preview. Automatic stock updates check all covered sellers.

### Set the starting stock for automatic updates

1. In **Order matching**, confirm the billing setup for each participating Flipkart seller account. You can map a few listings in **Inventory** now and map others from their orders later.
2. Choose **Set starting stock** and select **Track Flipkart orders from (India)**. Choose an Indian calendar date within the last 30 days. Tracking starts at midnight on that day and continues even with company sync off. Every earlier Flipkart sale must already be recorded in Tally. If your oldest unbilled sale is from Monday, choose Monday or earlier.
3. Confirm the stock source and Set of for the listings already mapped. Only standard and self-ship seller-fulfilled orders are covered. If Smart, Express or Fulfilment by Flipkart orders draw on the same stock, leave the setup unconfirmed. Choose **Confirm starting stock** after checking the statements.
4. When an unmapped order arrives, open **Order matching** for its seller and choose **Map listing**. Open **Tally stock item**, type part of its name or Tally ID, and choose the matching item. The choices show the unit and Tally ID to distinguish similar names. Confirm the **Set of** that applied to the waiting orders. One mapping covers that seller’s listing at that pickup location, including future orders. With company sync on, choose **Keep this listing paused** if you only want to count its orders. After saving, check the result for the waiting orders. A matching bill in the selected ledger settles its order. An unbilled sale reserves the units, including when a bill was mistakenly posted to another ledger.

While an order waits for its first mapping, existing mapped listings keep syncing. For example, an unmapped pair may draw from the same tyres as a mapped single. The singles calculation can then show two extra tyres until you record the bill or identify the pair’s source. Review waiting orders promptly.

For a single-tyre listing with the tyre minimum switched off, 4 in Tally and one unbilled order leave 3 available. Receiving two more tyres brings Tally to 6 and available stock to 5. When you bill that same sale, Tally falls to 5 and Stockbridge releases the one reserved tyre. Available stock stays at 5. Pack sizes and any selected tyre minimum apply after the deduction.

Adding a first mapping for a tracked seller keeps the company’s original start date and saved orders. Changing an established stock source, Set of or billing rule can require **Review starting stock**. A restart preserves tracking. After a database restore, reconcile earlier sales and set the company’s starting stock again. Only move the date forward once every earlier sale has been accounted for in Tally.

For a large order history, a full check may repeatedly take longer than the two-minute freshness limit. Reconcile the older sales against Tally, then choose **Review starting stock** and confirm a more recent start date. Keep any unbilled sale within the tracked period.

## 6. Understand refresh and background checks

- The default Tally check interval is **30 seconds after the preceding check finishes**. A slow or failed check can make the next check later; failures cause longer waits before retrying.
- To change it, open **Settings**, change the Tally stock interval and select **Save settings**. No Stockbridge restart is needed. Start with the default unless your provider has measured a reason to change it.
- **Refresh Tally** requests a check now for the selected company. **Connections > Check & discover companies** discovers and reads the loaded companies.
- Newly created stock items appear after a successful read. Their records are then saved in the local database; the list is not permanently fixed at installation.
- The dashboard periodically reads the saved state too. Allow a little time for an automatic background result to appear, or use the refresh action.
- **Settings > Marketplace stock** controls how often Stockbridge checks participating sellers for new Flipkart orders. **Listing metadata** controls the separate refresh of package counts and listing details. **Marketplaces > Refresh listings** requests a catalogue refresh now.

Tally must be open with the relevant company loaded for fresh stock. Turning off the PC, sleeping it, signing out, closing Tally or stopping Stockbridge interrupts some or all of these checks. A restart of Windows does not automatically start this pilot; follow the daily startup steps below.

## 7. Set up and verify backups

Stockbridge already uses **SQLite**, a database stored in a file on your computer. You do not install a separate database server or create database tables yourself. It saves the application's observations, settings, drafts, mappings and history across restarts. It does not replace Tally or back up the customer's Tally company.

1. Ask your provider to help choose a backup destination, preferably on a separate customer-controlled drive.
2. In File Explorer, open that folder. Click its address bar and copy the complete folder path.
3. In Stockbridge, open **Settings > Backup folder**. Paste the complete path, for example **D:\Stockbridge Backups** if that drive and folder belong to your computer. Do not blindly copy an example drive letter that does not exist.
4. Select **Save settings**. Stockbridge checks that it can write there. If it fails, the previous folder remains saved; correct the folder or its access permissions and try again.
5. Select **Back up now**. Wait for **Verified backup saved** and note the displayed location.
6. Open that location in File Explorer. Keep both the **.sqlite** backup file and the matching **.json** information file together.
7. Create a backup after setup, before each application update, and regularly during the pilot. Automatic backup scheduling/retention is not implemented yet.

Use **Back up now**, not a manual copy of the database while the app is running. Some committed changes can be in a companion working file; the app's verified backup includes them correctly.

Changing the backup folder affects future backups immediately. It does not move older backups. Completed backup copies can be stored elsewhere; keep the **active database** on the local computer, outside OneDrive/Dropbox and network shares. Backups contain business information, so share them only with authorized support.

Flipkart application credentials are not included in these database backups. Restoring the stock database in the same workspace keeps its existing protected credential file. Access tokens are held only while Stockbridge is running. After restarting, check the intended account and wait for a successful listing refresh, or choose **Refresh listings** yourself. A moved/new workspace, another computer or another Windows login needs credential setup again. Do not send protected credential files as a support attachment or try to copy them to another Windows login. After recovery, seller bindings remain but listing freshness is cleared; refresh each account before Apply or Check result. Unfinished attempts remain uncertain and are not resent automatically.

If you need to recover a backup, stop normal work and contact the provider. The pilot has no customer-facing import/restore button. Support can inspect a verified pilot backup and, with your approval, restore it while the app is stopped. This keeps a safety copy and your current connection settings, then requires fresh stock reads. Do not overwrite the active database yourself or assume that an old backup can safely resume marketplace policies. Your provider can guide you through recovery. A Stockbridge recovery restores the local inventory workspace. Your Tally accounting records and the quantities on Flipkart remain separate.

Restore also keeps seller identities and unresolved marketplace updates recorded after the chosen backup. It refuses a backup that conflicts with a known seller, weakens a current sales allowance, or loses a paused destination. Support must reconcile that conflict before replacement; the existing workspace stays intact.

## 8. Daily start, status and stop

**At the beginning of the day:**

1. Sign into the same Windows account used during setup.
2. Open Tally and load the required company.
3. Double-click **Start Stockbridge.cmd** in the same extracted application folder.
4. Check the selected company, connection result and stock observation time.
5. Open **Inventory** and confirm the expected mappings, **Set of** values and company automation setting. Check that the Tally and marketplace observations are fresh. For an uncertain publication, open the listing in **Marketplaces** and check the result.

**To check whether it is running:** double-click **Stockbridge Status.cmd**. It displays whether this installation is responding, the dashboard address and the data folder. The window waits for a key so you can read it. Do not share the contents of the internal runtime-control file found in that folder.

**To stop it:** double-click **Stop Stockbridge.cmd**. Wait for the confirmation that it stopped and saved data was retained. The application finishes an active source operation before closing its database. Closing only the browser is not the stop action. If shutdown is still finishing, wait and check Status before changing application files.

**After restarting Windows:** open Tally and use Start again. Automatic Windows startup, a Windows service and automatic crash restart are not included in this portable pilot.

## 9. Where your data lives

Use **Open Data Folder.cmd** to open the active pilot data folder in File Explorer. For the packaged pilot it is under your Windows profile:

`%LOCALAPPDATA%\Stockbridge\Pilot\data`

`%LOCALAPPDATA%` is Windows' name for a local folder belonging to your signed-in user. You can paste the full line above into File Explorer's address bar. Different Windows logins have different folders. Switching Windows users can therefore show an empty, separate workspace.

| File or folder                                           | What it contains                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `live.sqlite`                                            | Stockbridge's saved customer workspace; do not edit it directly                                      |
| `live.sqlite-wal` and `live.sqlite-shm`, when present    | SQLite's working files; do not delete while running                                                  |
| `backups`                                                | Default backup folder, unless changed in Settings                                                    |
| `migration-backups`                                      | Safety copies made for supported database-version upgrades                                           |
| `restore-backups`                                        | Safety copies kept before a technician-assisted pilot restore                                        |
| `live.diagnostics.ndjson`                                | Technical activity/error details for support                                                         |
| `startup.log`                                            | Startup messages if the dashboard could not open                                                     |
| `live.runtime.json`, while running                       | Private control information used by Start/Stop/Status; do not share it                               |
| `marketplace-credentials/<account-id>/`, when configured | Separate Windows-protected credentials for each added account; excluded from backups                 |
| `flipkart-self-access.credentials`, when configured      | Legacy primary account credentials; retained in place, excluded from backups and support attachments |

Application files and customer data are separate. Extracting a new application version does not itself move or erase this data. Starting from another extracted copy under the same Windows login uses this same pilot workspace; only one instance can own it at a time. Do not run two different versions against it.

A developer running a source checkout normally uses that checkout's **.data** folder instead. That is a different workspace. Installing this pilot does not automatically copy an earlier developer/pilot database into the new location; have the provider plan any transfer.

A fresh installation starts with an empty live inventory workspace. Your company records, credentials and mappings are stored under your Windows login. Keep your verified backups when moving to a new computer.

## 10. Updates, recovery and removing the pilot

1. On the same PC, sign in with the Windows account you normally use for Stockbridge. Extract the provider's new ZIP into a new application folder. If support configured a custom data folder, use the same setting for the upgrade.
2. Double-click **Upgrade Stockbridge.cmd** in the **new** folder. It stops the running copy, verifies a safety copy of the existing database in `migration-backups`, upgrades the database if needed, and opens the new dashboard. Keep the window open until the dashboard is ready. Existing seller credentials stay in the same Windows data folder.
3. Check your company, seller account and a familiar stock mapping. For daily use, open **Stockbridge** on your desktop. A successful upgrade creates this shortcut or updates the one Stockbridge created previously. If a personal shortcut already uses that name, or Windows restricts desktop changes, use **Start Stockbridge.cmd** in the new folder.

Your saved company sync settings, individual listing pauses and remaining sales allowances carry forward. Automatic updates for eligible listings resume after the usual checks. A paused listing stays paused.

If the workspace upgrade completes and the dashboard fails to start, run **Upgrade Stockbridge.cmd** again from the new folder. If the problem continues, give support the displayed safety-copy and startup-log locations. Keep the original safety copy. Support handles backup restoration separately when needed.

If Upgrade cannot find your workspace, use **Stockbridge Status.cmd** in the old folder to check its data path. Contact support if the upgrade reports an error. Keep the old application folder and the safety copy. Opening an upgraded database with the old application is unsupported.

There is no automatic updater or uninstall wizard. To remove application files, stop the app first and remove only its extracted application folder. The separate data folder remains. Deleting the data folder or backups is a separate decision and can permanently remove saved work; do it only after arranging a verified retained backup with the data owner.

An application backup is not a rollback of Tally bills or marketplace orders. Production restore must reconcile those sources before publication resumes. That full recovery workflow is still a release blocker.

## 11. If something goes wrong

| What you see                                      | What to do                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-clicking Start does not work               | Extract the entire ZIP first. Check that `runtime` and `dist` are beside the launch files. If Windows blocks the file, contact the provider/IT team.                                                                                                    |
| Browser says the page cannot be reached           | Run Status. If stopped, use Start. Use `http://127.0.0.1:4310` on this computer, not a phone or another PC.                                                                                                                                             |
| Startup says the address/port is in use           | Another app or Stockbridge instance may already use 4310. Contact support; do not close an unknown process or change database files.                                                                                                                    |
| Startup failed or Status cannot confirm the app   | Use Open Data Folder and retain `startup.log` for support. Do not share `live.runtime.json`.                                                                                                                                                            |
| Tally is Offline or discovery fails               | Open Tally on this computer, load the company, confirm the HTTP port matches Settings, follow any Tally restart prompt, then retry Check & discover companies.                                                                                          |
| Correct company is missing                        | Load it in Tally, then discover again. Do not select another company merely because its name is similar.                                                                                                                                                |
| Stock differs from Tally                          | Compare company, date/reporting period, units and company-wide totals. Record the example and ask support to investigate; do not replace unknown values with zero.                                                                                      |
| Old stock remains after a failure                 | This is the last saved observation, not a successful new read. Follow the connection error and refresh successfully.                                                                                                                                    |
| New Tally item is missing                         | Confirm it belongs to the selected company and use Refresh Tally after saving it in Tally.                                                                                                                                                              |
| No Flipkart listings or a stock update is blocked | Open the intended account and choose **Refresh listings**. Check Tally freshness and the listing's **Set of** cell. Open **Review changes** for the reason on each blocked row.                                                                         |
| API credentials are rejected or need attention    | Check the application belongs to the intended seller, its access is active, and the ID/secret were copied correctly. Use Check connection or Update credentials on the intended account tile, then Refresh listings. Do not send the secret to support. |
| Self Access registration asks for a website       | Enter the public website for your own business or application. Ask your provider if you need help identifying the correct address.                                                                                                                      |
| Backup cannot be saved                            | Check that the saved folder/drive exists, is writable and has free space. Keep the live database and any previous verified backups.                                                                                                                     |
| A new Windows login shows no data                 | Stop and check the original Windows account and data folder with support before creating a second workspace.                                                                                                                                            |

Open **Activity > Business activity** for understandable action history. Open **Activity > Diagnostics** for technical details, then use **Export diagnostics** when support requests them. Record the time of the problem, the action, the app/package version from Status/manifest, the selected company and any request reference shown in the error. Redact business details that support does not need. Never send passwords, application secrets, runtime-control files or complete order/customer payloads casually.

## What is still required for Flipkart synchronization

Live stock publication requires the seller's permission to test a real SKU and location. With the provider, first confirm the company balance and units against Tally, the account's listings and locations against Flipkart, and the **Set of** choice against the actual contents of one sale. Compare a small reviewed publication with seller-visible stock before enabling ongoing company updates.

The pilot uses company-wide balances. Per-godown stock allocation, live order tracking for finite sales allowances and production recovery still need further work. An existing sales allowance needs an explicit policy change before a conflicting direct edit can be applied.

Each seller using Self Access registers its own application and supplies its credentials locally. Ask your provider to confirm the access arrangement for your account before starting the pilot. See [Flipkart's registration instructions](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration).
