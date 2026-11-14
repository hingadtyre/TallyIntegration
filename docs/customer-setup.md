# Stockbridge: customer setup and daily use

**Version: 0.1.0 read-only pilot. Guide checked on 2026-11-08.**

Stockbridge is intended to keep marketplace stock in step with Tally. **This version does not import Flipkart listings or change any Flipkart stock.** It can read Tally stock and verify credentials for a seller-owned Flipkart Self Access application. Keep using your existing process for managing marketplace stock.

The steps below work for the current pilot. The Flipkart part of a complete setup is explained separately under **What is still required for Flipkart synchronization**. A successful Tally connection does not mean marketplace synchronization has started. The [release-readiness checklist](release-readiness.md) records the remaining development and provider work.

HingadTyre is our first customer. HINGADTYRES was seen on its seller website, but that browser login is not an application connection. A fresh installation shows a neutral **Flipkart seller** label. Even a successful API credential check does not yet identify the seller or import its listings.

## Before you start

Arrange a setup time with the person providing Stockbridge. Have these available:

- The Windows computer on which you normally run Tally and create bills. This pilot must run on that same computer. The package is for **Windows x64**, not a phone, Mac or Windows ARM installation.
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
4. Check that the dashboard says marketplace publishing is unavailable. This is expected for this pilot.

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
4. Confirm a Tally item appears even if it has no Flipkart listing. The current live pilot does not import Flipkart listings, so empty mapping/listing sections are expected.
5. If another company is loaded, switch companies and confirm its quantities stay separate.
6. After an ordinary sale is billed in Tally, use **Refresh Tally** and check the resulting quantity. Do the same after an ordinary stock receipt when practical. Do not create a fictitious live bill just to test the app.
7. Ask the provider to record the verified Tally release, company/item identities, units, reporting period and results. Differences must be investigated before the display is accepted.

**This version reads company-wide closing balances.** It does not yet select individual godowns for each Flipkart warehouse. A godown is a Tally stock location. If your business has several locations, the total shown must not be treated as the availability at a particular marketplace warehouse.

A dash **-** means the quantity is unknown or unavailable, not zero. If a read fails, the last saved quantity can remain visible. Check the connection message and observation time before interpreting it as current stock. The app must not invent zero to hide a failed read.

Brands are not extracted by the current live Tally reader. Brand filters become useful only when reliable brand information is available; a blank brand is not a missing stock item.

## Optional: verify seller-owned Flipkart API access

This step stores or tests API credentials only. It does not begin stock synchronization. This branch uses the seller's own **Self Access** application; no Stockbridge-hosted authentication server is needed. HingadTyre has confirmed that it owns Stockbridge and uses it for its own seller account, matching the documented Self Access category. Flipkart must still approve the application. Partners/aggregators serving other sellers use a separate third-party flow; this own-account setup is not permission to distribute the product to independent sellers. [Flipkart's access rules](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration)

1. Sign into the correct account on Flipkart's seller website and check the seller name.
2. Open **Profile > Developer Access > Self Access**. HingadTyre's **Stockbridge Local** application was submitted on 2026-11-08 and currently shows **Pending**; do not create a duplicate. For an account without its own application, choose **Create New Access** and provide accurate **Application Name**, **Description** and **Website Domain** information. The submitted HingadTyre application uses [the Stockbridge project URL](https://github.com/hingadtyre/TallyIntegration). The local authentication flow needs no purchased domain or hosted authentication service. Do not invent a website or use the local dashboard address as a public website.
3. Wait for Flipkart to approve the application. The observed confirmation said **Sent for Approval** and stated that Flipkart would contact the registered phone/email within **7 working days**. This is Flipkart's displayed guidance, not a guaranteed approval date. If approval remains pending beyond that period, follow up with Flipkart support. Existing unrelated integrations should not be changed or revoked.
4. When Flipkart makes usable credentials available, keep the **API Key/Application ID** and **Secret** private. These are not your seller login password. If a Copy control produces nothing, do not guess a value; wait for usable credentials or contact Flipkart support.
5. In the live Stockbridge dashboard, open **Connections** and enter **Application ID** and **Application Secret**. Choose **Save credentials for later** to protect them on this computer without contacting Flipkart. This replaces any previously saved application credentials and clears their verified access state. The panel shows **Needs attention**, with check/expiry times **Not yet observed**. It does not test or approve the new credentials.
6. After Flipkart approves access, choose **Check saved access**. Alternatively, choose **Verify and save credentials** when first entering approved credentials; this option requests a token and saves only after a successful check. If that verification fails, the previous saved credentials remain. Wait for **API credentials verified** and the check/expiry times before treating token access as verified.
7. After restarting Stockbridge, use **Check saved access** again; the previous token is held only in memory. Saved credentials do not mean an active verified token, and a local status does not establish Flipkart's approval status. Stockbridge can obtain replacement access tokens when needed. It does not start a listing importer or marketplace polling schedule in this version.
8. Use **Disconnect locally** to remove this installation's saved credentials. That does not delete the application on Flipkart or change stock. Revoke/delete access on Flipkart separately if that is your intention.

This pilot supports one saved application per live workspace. Credentials are protected for the current Windows user and kept outside the stock database and its backups. Sample mode and unsupported operating systems do not accept them. The form clears entered credentials after a successful save; the status displays only a masked application hint. Moving to another Windows login or computer requires connection setup again.

On 2026-11-08, the user submitted **Stockbridge Local**, description **Tally stock integration**, website **https://github.com/hingadtyre/TallyIntegration**. The HINGADTYRES application table now shows **Pending**. The Copy control returned no usable value during inspection; no secret has been copied into Stockbridge or verified. Registration submission is confirmed; application approval and real token access remain unverified.

## 6. Understand refresh and background checks

- The default Tally check interval is **30 seconds after the preceding check finishes**. A slow or failed check can make the next check later; failures cause longer waits before retrying.
- To change it, open **Settings**, change the Tally stock interval and select **Save settings**. No Stockbridge restart is needed. Start with the default unless your provider has measured a reason to change it.
- **Refresh Tally** requests a check now for the selected company. **Connections > Check & discover companies** discovers and reads the loaded companies.
- Newly created stock items appear after a successful read. Their records are then saved in the local database; the list is not permanently fixed at installation.
- The dashboard periodically reads the saved state too. Allow a little time for an automatic background result to appear, or use the refresh action.
- Marketplace and catalog intervals shown in Settings are future preferences. **They do not run Flipkart checks in this version.**

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

Flipkart application credentials are not included in these database backups. Restoring the stock database in the same workspace keeps its existing protected credential file. Access tokens are held only while Stockbridge is running, so choose **Connections > Check saved access** after restarting. A moved/new workspace, another computer or another Windows login needs credential setup again. Do not send protected credential files as a support attachment or try to copy them to another Windows login. After recovery, check the intended account/connection separately before relying on any marketplace feature.

If you need to recover a backup, stop normal work and contact the provider. The pilot has no customer-facing import/restore button. Support can inspect a verified pilot backup and, with your approval, restore it while the app is stopped. This keeps a safety copy and your current connection settings, then requires fresh stock reads. Do not overwrite the active database yourself or assume that an old backup can safely resume marketplace policies. The [provider recovery procedure](../CONTRIBUTING.md#restore-a-pilot-backup-support-only) is for supervised support; it does not restore Tally accounting data or change Flipkart.

## 8. Daily start, status and stop

**At the beginning of the day:**

1. Sign into the same Windows account used during setup.
2. Open Tally and load the required company.
3. Double-click **Start Stockbridge.cmd** in the same extracted application folder.
4. Check the selected company, connection result and stock observation time.
5. Continue your existing Flipkart stock-management process. This pilot does not synchronize marketplace quantities.

**To check whether it is running:** double-click **Stockbridge Status.cmd**. It displays whether this installation is responding, the dashboard address and the data folder. The window waits for a key so you can read it. Do not share the contents of the internal runtime-control file found in that folder.

**To stop it:** double-click **Stop Stockbridge.cmd**. Wait for the confirmation that it stopped and saved data was retained. The application finishes an active source operation before closing its database. Closing only the browser is not the stop action. If shutdown is still finishing, wait and check Status before changing application files.

**After restarting Windows:** open Tally and use Start again. Automatic Windows startup, a Windows service and automatic crash restart are not included in this portable pilot.

## 9. Where your data lives

Use **Open Data Folder.cmd** to open the active pilot data folder in File Explorer. For the packaged pilot it is under your Windows profile:

`%LOCALAPPDATA%\Stockbridge\Pilot\data`

`%LOCALAPPDATA%` is Windows' name for a local folder belonging to your signed-in user. You can paste the full line above into File Explorer's address bar. Different Windows logins have different folders. Switching Windows users can therefore show an empty, separate workspace.

| File or folder                                        | What it contains                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `live.sqlite`                                         | Stockbridge's saved customer workspace; do not edit it directly                            |
| `live.sqlite-wal` and `live.sqlite-shm`, when present | SQLite's working files; do not delete while running                                        |
| `backups`                                             | Default backup folder, unless changed in Settings                                          |
| `migration-backups`                                   | Safety copies made for supported database-version upgrades                                 |
| `restore-backups`                                     | Safety copies kept before a technician-assisted pilot restore                              |
| `live.diagnostics.ndjson`                             | Technical activity/error details for support                                               |
| `startup.log`                                         | Startup messages if the dashboard could not open                                           |
| `live.runtime.json`, while running                    | Private control information used by Start/Stop/Status; do not share it                     |
| `flipkart-self-access.credentials`, when configured   | Windows-protected API credentials; not part of a stock backup and not a support attachment |

Application files and customer data are separate. Extracting a new application version does not itself move or erase this data. Starting from another extracted copy under the same Windows login uses this same pilot workspace; only one instance can own it at a time. Do not run two different versions against it.

A developer running a source checkout normally uses that checkout's **.data** folder instead. That is a different workspace. Installing this pilot does not automatically copy an earlier developer/pilot database into the new location; have the provider plan any transfer.

The package contains no HingadTyre data, credentials or preconfigured mappings. Cloning the source repository or downloading another ZIP does not restore customer records. A remote/cloud database is not needed for this local persistence. Moving inventory processing to a server would require a separate, planned migration.

## 10. Updates, recovery and removing the pilot

Arrange updates with the provider during the pilot:

1. Create a verified backup and retain its information file.
2. Use **Stop Stockbridge.cmd** and confirm it has stopped.
3. Keep the current application folder and the customer data folder. Extract the new, provider-verified package into a new application folder.
4. Have the provider confirm that the version supports your database and backup. Do not open a newer database with an older application to attempt a rollback.
5. Start the new version, check Status, company counts, saved settings and Tally observations, then take a fresh backup.
6. Keep the old package and safety backup until the provider confirms the update worked. Replace any desktop shortcut so it points to the new Start file.

There is no automatic updater or uninstall wizard. To remove application files, stop the app first and remove only its extracted application folder. The separate data folder remains. Deleting the data folder or backups is a separate decision and can permanently remove saved work; do it only after arranging a verified retained backup with the data owner.

An application backup is not a rollback of Tally bills or marketplace orders. Production restore must reconcile those sources before publication resumes. That full recovery workflow is still a release blocker.

## 11. If something goes wrong

| What you see                                       | What to do                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-clicking Start does not work                | Extract the entire ZIP first. Check that `runtime` and `dist` are beside the launch files. If Windows blocks the file, contact the provider/IT team.                                                           |
| Browser says the page cannot be reached            | Run Status. If stopped, use Start. Use `http://127.0.0.1:4310` on this computer, not a phone or another PC.                                                                                                    |
| Startup says the address/port is in use            | Another app or Stockbridge instance may already use 4310. Contact support; do not close an unknown process or change database files.                                                                           |
| Startup failed or Status cannot confirm the app    | Use Open Data Folder and retain `startup.log` for support. Do not share `live.runtime.json`.                                                                                                                   |
| Tally is Offline or discovery fails                | Open Tally on this computer, load the company, confirm the HTTP port matches Settings, follow any Tally restart prompt, then retry Check & discover companies.                                                 |
| Correct company is missing                         | Load it in Tally, then discover again. Do not select another company merely because its name is similar.                                                                                                       |
| Stock differs from Tally                           | Compare company, date/reporting period, units and company-wide totals. Record the example and ask support to investigate; do not replace unknown values with zero.                                             |
| Old stock remains after a failure                  | This is the last saved observation, not a successful new read. Follow the connection error and refresh successfully.                                                                                           |
| New Tally item is missing                          | Confirm it belongs to the selected company and use Refresh Tally after saving it in Tally.                                                                                                                     |
| No Flipkart listings, or publishing is unavailable | Expected for this pilot. There is no hidden setting, password or restart that enables the unimplemented integration.                                                                                           |
| API credentials are rejected or need attention     | Check the application belongs to the intended seller, its access is active, and the ID/secret were copied correctly. Use Check saved access or replace them in Connections. Do not send the secret to support. |
| Self Access registration asks for a website        | Supply accurate seller/application website information. The submitted HingadTyre application uses the Stockbridge project URL and is Pending. The local dashboard address is not a public website.             |
| Backup cannot be saved                             | Check that the saved folder/drive exists, is writable and has free space. Keep the live database and any previous verified backups.                                                                            |
| A new Windows login shows no data                  | Stop and check the original Windows account and data folder with support before creating a second workspace.                                                                                                   |

Open **Activity > Business activity** for understandable action history. Open **Activity > Diagnostics** for technical details, then use **Export diagnostics** when support requests them. Record the time of the problem, the action, the app/package version from Status/manifest, the selected company and any request reference shown in the error. Redact business details that support does not need. Never send passwords, application secrets, runtime-control files or complete order/customer payloads casually.

## What is still required for Flipkart synchronization

**The current customer setup stops after the read-only and optional credential checks above.** These remaining steps cannot be completed in this version, and are not instructions to search for missing buttons.

The application still needs authenticated seller identity, listing import, stock-location mapping, order accounting, publication and recovery implementation. HingadTyre's internal own-account use matches the documented Self Access category and avoids a hosted Stockbridge authentication service, but its application approval is pending. Distribution to independent sellers remains a separate eligibility question. If that requires the provider-managed route, partner registration and a hosted HTTPS authorization service remain separate work. The local authentication check does not satisfy those requirements.

**Does this route need application registration?** Yes. Each seller creates its own Self Access application and supplies its API credentials locally. It is not the purchase or installation of another customer program. The public registration guide does not establish a registration fee. The alternative provider-managed route registers Stockbridge once and uses seller consent through a hosted service. See [the branch's decision](adr/0004-seller-owned-flipkart-self-access.md) and [Flipkart's registration instructions](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration).

Once those features are implemented, tested and released, the complete customer journey will be:

1. Receive the verified production package, install it, and confirm its supported background startup, backup and recovery behavior.
2. Configure the local Tally connection, verify the company and units, and explicitly select the Tally godowns that supply the marketplace locations.
3. Complete the eligible account-authorization route and verify the connection. This branch uses the seller-owned credentials described above; a provider-managed release would use Flipkart's consent page instead. No separate Stockbridge invitation, activation code or customer signup is planned.
4. Confirm the authenticated seller identity and its stock locations. For HingadTyre, verify the actual HINGADTYRES account; a display label alone is insufficient.
5. Import existing listings and current marketplace stock. Compare each listing's tyre brand/model/dimensions and verified set size with its Tally stock item. Mapping links existing records; it does not create products in either system.
6. Verify pack evidence. For HingadTyre's one-tyre-per-shipping-package practice, package count can be a fallback only after verifying that listing. Do not guess from SKU endings or title digits.
7. Review proposed stock for an explicitly selected small set of listings. Confirm account, location, company, set size and quantity before publishing. Verify the result in Flipkart before expanding the scope.
8. Check automatic behavior using approved real activity: billing and stock receipt, a one-sale allowance for the exact listing, a persistent zero hold, Pause/resume, a failed connection and restart/recovery. Orders must not be deducted twice or reopen an exhausted allowance.
9. Enable routine automation only after those checks and a supported backup/restore exercise pass. Record the provider's support contact and recovery procedure.

For HingadTyre's agreed tyre rule, a listing with no complete pack must be zero. If at least one complete pack exists, its normal advertised quantity uses a minimum of five. This is a named business policy accepted for this customer/category, not evidence that five physical packs exist. Duplicate listings share the same underlying stock, so simultaneous sales before billing/synchronization remain possible. The customer and provider must review low physical stock and the agreed exposure during activation.

All remaining application, provider and customer acceptance checks are tracked in [First-customer release readiness](release-readiness.md). The provider's technical workflow is in [CONTRIBUTING](../CONTRIBUTING.md); it is not required reading or a command checklist for the customer.
