export function CustomerSetup() {
  return (
    <section className="panel setup-panel">
      <h2>Customer setup · HingadTyre</h2>
      <p>
        Complete these steps on the customer's Tally computer. Development can continue with the
        separate sample workspace. Tally discovery and manual backups are available now. Flipkart
        connection and synchronization remain planned features.
      </p>
      <ol>
        <li>
          <strong>Prepare Tally on the customer's computer.</strong>
          <span>
            Open the intended company. Use F1 (Help) → Settings → Connectivity → Client/Server
            Configuration to enable the HTTP server, normally on port 9000. Older versions may use
            Advanced Configuration. Follow the installed version's labels and restart prompt.
          </span>
        </li>
        <li>
          <strong>Enter the local address and discover companies.</strong>
          <span>
            In Settings, use http://127.0.0.1:9000/ or the configured port. Then choose Check &
            discover companies on this page. Select one company and compare its quantities with
            Tally for the same date.
          </span>
        </li>
        <li>
          <strong>Future step: authorize your Flipkart seller account.</strong>
          <span>
            Stockbridge's provider must first complete its Flipkart application registration and
            connection service. Once available, start connection here, sign in on Flipkart and
            review consent for the Stockbridge application. Each customer authorizes their own
            account, HINGADTYRES for this installation. You do not need to create or share
            self-access credentials. This connection flow is not available yet.
          </span>
        </li>
        <li>
          <strong>After connection: verify stock locations and every pack mapping.</strong>
          <span>
            Compare tyre identity, base units, set size and location. One tyre per shipping package
            is usable evidence only where verified for that listing. The first Tally connector reads
            company totals; location-specific publication is pending.
          </span>
        </li>
        <li>
          <strong>Future release: review before enabling synchronization.</strong>
          <span>
            Check newly added items, normal stock changes, limited sales and zero holds. Choose a
            backup folder and test Back up now. Marketplace publishing, scheduled backups and
            restore remain unavailable in this build.
          </span>
        </li>
      </ol>
      <p>
        <a
          href="https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/"
          target="_blank"
          rel="noreferrer"
        >
          Tally connection guide ↗
        </a>{' '}
        ·{' '}
        <a
          href="https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration"
          target="_blank"
          rel="noreferrer"
        >
          Flipkart authorization guide ↗
        </a>
      </p>
    </section>
  );
}
