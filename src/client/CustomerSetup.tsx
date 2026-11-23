export function CustomerSetup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <section className="panel setup-panel">
      <h2>Set up this pilot</h2>
      <p>
        Use Stockbridge on the same Windows computer as Tally. This version reads your stock and
        saves verified backups. In Marketplaces, add your seller-owned Flipkart accounts and refresh
        their listings. Apply in a listing editor changes that value on Flipkart.
      </p>
      <ol>
        <li>
          <strong>Open your company in Tally.</strong>
          <span>
            In TallyPrime, look under F1 (Help) → Settings → Connectivity → Client/Server
            Configuration. Enable HTTP Server or Both, usually on port 9000. Some versions use
            Advanced Configuration instead. Follow your version's labels and any restart prompt,
            then reopen your company. This connection stays on your computer; no internet tunnel is
            needed.
          </span>
        </li>
        <li>
          <strong>Check the connection address.</strong>
          <span>
            Open Settings. Under Connection address, enter http://127.0.0.1:9000/ and replace 9000
            if you chose a different port in Tally. Choose Save settings, return to Connections,
            then choose Check & discover companies. If the check fails, follow the message and try
            again. Previously read stock stays visible.
          </span>
        </li>
        <li>
          <strong>Compare your stock with Tally.</strong>
          <span>
            Select the intended Tally company at the top, then open Inventory. Compare several items
            and quantities with Tally for the same company and date. The figures are company totals,
            not separate godown balances. A dash means unknown, not zero. Use Refresh Tally after a
            normal stock change and check the observation time.
          </span>
        </li>
        <li>
          <strong>Make a backup.</strong>
          <span>
            In Settings, keep the suggested Backup folder or enter a full writable folder path. Save
            settings before using Back up now, then look for the verified-backup confirmation. This
            backs up Stockbridge records, not your Tally accounting data or API credentials.
            Automatic backups are not available. Contact support for a supervised offline pilot
            restore.
          </span>
          <button className="text-button" onClick={onOpenSettings}>
            Open backup settings
          </button>
        </li>
      </ol>
      <details className="guide-topic">
        <summary>Start and stop the Windows pilot</summary>
        <p>
          Extract the entire supplied ZIP and double-click <strong>Start Stockbridge.cmd</strong>.
          It opens the dashboard and keeps stock checks running in the background when you close
          your browser. Start it again after signing in to Windows; automatic startup is not
          installed. Keep the computer awake and Tally open with your company loaded.
        </p>
        <p>
          Use <strong>Stop Stockbridge.cmd</strong> to stop the app and{' '}
          <strong>Stockbridge Status.cmd</strong> to check whether it is running. Use{' '}
          <strong>Open Data Folder.cmd</strong> to find its saved files and{' '}
          <strong>Read Me.html</strong> for the full setup and troubleshooting guide.
        </p>
      </details>
      <details className="guide-topic">
        <summary>Set up seller-owned Flipkart access</summary>
        <p>
          In your seller dashboard, open Manage Profile → Developer Access → Create New Access.
          Register an application for your own seller use, then enter its Application ID and
          Application Secret under Marketplaces → Add account → Flipkart. Give each account a name.
          If Flipkart approval is pending, save credentials for later without verifying. After
          approval, use Check connection on its account tile. Verify and save and Check connection
          both attempt a listing import after access is verified. Open listings shows the imported
          catalogue. No hosted Stockbridge authentication service is used. Sample mode does not
          accept credentials or contact Flipkart.
        </p>
        <p>
          Flipkart restricts Self Access to the seller's own use. Confirm this arrangement is
          appropriate for your installation. A verified API credential is not proof of the seller's
          identity or approval for a third-party product. Refresh listings checks which listings the
          authenticated account owns.
        </p>
      </details>
      <details className="guide-topic">
        <summary>Map listings and manage stock updates</summary>
        <p>
          In Inventory, select the company and seller account, then choose Map listing on the Tally
          item. Search your imported listings by seller SKU, product title when available, FSN
          (Flipkart product ID) or Flipkart listing ID. If Flipkart supplied no stock location,
          choose this seller’s pickup location or save the mapping and choose it later in Edit Set
          of. Check the product and warehouse before selecting a suggested listing. For Set of,
          choose the shipping package count when it matches the Tally units used per sale, or enter
          your own number. Confirm that the company-wide balance supplies the selected Flipkart
          location. Enable the tyre minimum only for eligible tyre listings. Stockbridge saves these
          choices in this workspace and reloads them on restart.
        </p>
        <p>
          To set stock aside, edit Keep back from marketplaces beside the item's Tally stock. Enter
          the quantity in its Tally unit and choose Save. Stockbridge deducts it once across the
          item's listings, then applies each listing's Set of and tyre minimum. Enter zero to
          release the stock. Eligible listings update on the next sync.
        </p>
        <p>
          Before enabling company sync, review the seller accounts, locations and expected
          quantities in Inventory. Try one listing lets you approve a single update and verify it
          while company sync stays off. Paused listings stay paused. Waiting listings can start when
          their checks pass. If a Tally company cannot be read, check its last successful read.
          Other verified companies can continue.
        </p>
        <p>
          Choose Saved proposals at the top of Inventory to see listings with drafts. Choose Tally
          stock items to return to all items. Use Calculate to create a draft. Stockbridge refreshes
          an outdated calculated draft automatically, even on a paused listing. A quantity you enter
          yourself stays yours to review. Review changes keeps the quantities you saw when it
          opened. Publish checks each listing again. If a calculated quantity has changed, you can
          review its new value from the results. Other eligible listings can still publish. For a
          positive manual edit on an Auto listing, choose Update once. Publishing a zero you entered
          pauses Tally sync at that location. When Tally stock falls too low to fill a set,
          Stockbridge can publish a calculated zero and update the listing again after restocking.
          With automatic updates enabled, a change in Tally stock recalculates eligible listings. A
          verified Flipkart sale can also lower stock on other listings supplied by the same Tally
          item before the sale is billed. Review any package-count changes in the listing’s Set of
          cell. If a bulk calculation reports blocked listings, use Fix Set of where offered or
          review the ready drafts.
        </p>
      </details>
      <details className="guide-topic">
        <summary>Match Flipkart orders to Tally bills</summary>
        <p>
          To see which recent Flipkart orders you have billed, open Order matching. Select the Tally
          company and Flipkart account, choose your Flipkart sales bill ledger, and select the bill
          field where you record an order or invoice number. You can also match manually. Preview
          the matches and confirm the setup for each participating seller. Choose the tracking start
          date after checking that earlier sales are in Tally. When an order needs a mapping, choose
          Map listing and confirm the Tally item and Set of at that pickup location. Stockbridge
          checks saved orders from your tracking date against the ledger and reserves unbilled
          units. A verified seller-fulfilled order can reserve stock before packing. Held orders
          need review. Existing listings keep syncing while a sale waits for its mapping, even if
          they share the same tyres.
        </p>
      </details>
      <details className="guide-topic">
        <summary>Edit marketplace stock and prices</summary>
        <p>
          In Marketplaces, use the pencil beside stock, MRP or selling price. Applying a manual
          stock edit to a Tally-mapped listing pauses sync at that warehouse. Flipkart can still
          deduct sales. Stockbridge skips automatic updates, including zero, until you choose Resume
          sync beside the lock. Resume replaces that location’s draft with a fresh proposed
          quantity. If Stockbridge cannot verify the stock, the row shows what needs attention. With
          company sync on, the next eligible update can publish. Existing sales allowances require
          an explicit policy change before a conflicting edit. If an update is uncertain, choose
          Check result. When the earlier stock request can no longer take effect, choose Review
          current stock. Compare Flipkart stock with the freshly calculated quantity and approve the
          value for that location. If the two match, approval completes the review without sending
          stock. Settlement editing opens Flipkart Seller Hub.
        </p>
      </details>
      <p>
        <a
          href="https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/"
          target="_blank"
          rel="noreferrer"
        >
          Tally's connection settings ↗
        </a>{' '}
        ·{' '}
        <a href="https://help.tallysolutions.com/xml-integration/" target="_blank" rel="noreferrer">
          Tally's alternative configuration guide ↗
        </a>{' '}
        Use only the local HTTP settings in these guides; Stockbridge does not need their tunnel or
        remote-access instructions.
      </p>
    </section>
  );
}
