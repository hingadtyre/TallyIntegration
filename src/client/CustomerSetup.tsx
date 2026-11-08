export function CustomerSetup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <section className="panel setup-panel">
      <h2>Set up this pilot</h2>
      <p>
        Use Stockbridge on the same Windows computer as Tally. This version reads your stock and
        saves verified backups. It does not connect to Flipkart or change marketplace stock.
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
            backs up Stockbridge records, not your Tally accounting data. Automatic backups and
            restoring a backup are not available in this version.
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
      <h3>Flipkart setup is not available yet</h3>
      <p>
        This version has no seller connection or listing import. Connecting your own seller account,
        verifying stock locations and packs, reviewing the first stock update, and enabling
        synchronization belong to a future release. No setting or browser sign-in can enable those
        missing features in this pilot.
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
