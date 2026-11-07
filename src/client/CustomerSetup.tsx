export function CustomerSetup() {
  return (
    <section className="panel setup-panel">
      <h2>Customer setup · HingadTyre</h2>
      <p>
        Complete these steps on the customer's Tally computer. Development can continue with the
        separate sample workspace.
      </p>
      <ol>
        <li>
          <strong>Prepare Tally on the customer's computer.</strong>
          <span>
            Open the intended company. In supported TallyPrime versions, use F1 (Help) → Settings →
            Advanced Configuration to enable the HTTP server, normally on port 9000. Follow Tally's
            restart prompt if shown; menus vary by version.
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
          <strong>Authorize the HINGADTYRES seller account.</strong>
          <span>
            The observed account and listing evidence remain relevant. API authorization is separate
            from browser sign-in. Seller-owned and third-party integrations use different Flipkart
            authorization routes; choose the applicable route before connecting. Credential setup is
            still being implemented.
          </span>
        </li>
        <li>
          <strong>Verify stock locations and every pack mapping.</strong>
          <span>
            Compare tyre identity, base units, set size and location. One tyre per shipping package
            is usable evidence only where verified for that listing. The first Tally connector reads
            company totals; location-specific publication is pending.
          </span>
        </li>
        <li>
          <strong>Review before enabling synchronization.</strong>
          <span>
            Check newly added items, normal stock changes, limited sales and zero holds. Choose a
            backup folder and test Back up now. Marketplace publishing, scheduled backups and
            restore remain unavailable in this build.
          </span>
        </li>
      </ol>
      <p>
        <a href="https://help.tallysolutions.com/xml-integration/" target="_blank" rel="noreferrer">
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
