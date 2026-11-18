export function CustomerSetup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <section className="panel setup-panel">
      <h2>Set up this pilot</h2>
      <p>
        Use Stockbridge on the same Windows computer as Tally. This version reads your stock and
        saves verified backups. In Marketplaces, add your seller-owned Flipkart accounts and refresh
        their listings. Apply in a listing editor changes that value on Flipkart. Automatic Tally
        publishing and Inventory proposal publishing remain unavailable.
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
          <button className="text-button" onClick={onOpenSettings}>
            Open Tally settings
          </button>
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
      <h3>Starting and stopping the Windows pilot</h3>
      <p>
        Extract the entire supplied ZIP and double-click <strong>Start Stockbridge.cmd</strong>. It
        opens the dashboard and keeps stock checks running in the background when you close your
        browser. Start it again after signing in to Windows; automatic startup is not installed.
        Keep the computer awake and Tally open with your company loaded.
      </p>
      <p>
        Use <strong>Stop Stockbridge.cmd</strong> to stop the app and{' '}
        <strong>Stockbridge Status.cmd</strong> to check whether it is running. Use{' '}
        <strong>Open Data Folder.cmd</strong> to find its saved files and{' '}
        <strong>Read Me.html</strong> for the full setup and troubleshooting guide.
      </p>
      <h3>Set up seller-owned Flipkart access</h3>
      <p>
        In your seller dashboard, open Manage Profile → Developer Access → Create New Access.
        Register an application for your own seller use, then enter its Application ID and
        Application Secret under Marketplaces → Add account → Flipkart. Give each account a name. If
        Flipkart approval is pending, save credentials for later without verifying. After approval,
        check the saved access, open its account tile and choose Refresh listings. Verify and save
        checks access before saving. No hosted Stockbridge authentication service is used. Sample
        mode does not accept credentials or contact Flipkart.
      </p>
      <p>
        Flipkart restricts Self Access to the seller's own use. Confirm this arrangement is
        appropriate for your installation. A verified API credential is not proof of the seller's
        identity or approval for a third-party product. Refresh listings verifies the seller binding
        before editing. Tally pack/location mapping and automatic synchronization require further
        validation and implementation.
      </p>
      <p>
        Use the pencil beside stock, MRP or selling price, then Apply for that value only. For a
        Tally-managed listing, choose Update once or Pause Tally sync and update. Pause also stops
        automatic zero corrections until resumed. Existing holds and sales allowances require an
        explicit policy change before a conflicting edit. If an update is uncertain, choose Check
        result rather than repeating it. Settlement editing opens Flipkart Seller Hub.
      </p>
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
