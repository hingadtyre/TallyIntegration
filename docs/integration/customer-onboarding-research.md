# Customer onboarding research

Checked against official documentation on **2026-11-07** for Stockbridge's first customer, HingadTyre (seller display name **HINGADTYRES**). This is preparation, not evidence that the customer's computer or seller API access has been configured. The existing account/listing observations are recorded in [Flipkart validation](flipkart-validation.md).

## TallyPrime: verified local connection requirements

1. On the customer's Windows computer, open TallyPrime and load the intended company. Tally must remain running on the configured port; at least one company must be loaded. The integration exchanges XML using HTTP POST. [Tally integration prerequisites](https://help.tallysolutions.com/pre-requisites-for-integrations/)
2. Prefer the installed product's **F1 (Help) → Settings → Connectivity → Client/Server Configuration** screen when available. Select HTTP Server or Both, then set port **9000** or another unused port. Tally's October 2026 integration guide explicitly supports a same-computer endpoint such as `http://127.0.0.1:9000`. [Tally connectivity guide](https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/)
3. Another documented route is **Alt+Z (Exchange) → Configure → Client/Server Configuration**. Save and follow Tally's restart prompt; the synchronisation guide explicitly calls for a restart after this configuration. Confirm the displayed port under **F1 → About → Connectivity** and reload the company after restarting. This uses the connectivity section only; Tally-to-Tally synchronisation, Tally.NET setup and public-IP prerequisites are not requirements for Stockbridge's same-computer XML reader. [Tally client/server configuration, updated November 6, 2026](https://help.tallysolutions.com/set-up-for-data-synchronisation/)
4. The August 2025 XML guide instead names **F1 → Settings → Advanced Configuration**, then enabling HTTP on default port 9000. It lists ODBC separately as optional. Record the installed Tally version and actual menu labels; the reviewed sources do **not** establish a reliable 6.x-versus-7.0 menu split. [Tally XML configuration](https://help.tallysolutions.com/xml-integration/)
5. Put the matching endpoint in Stockbridge Settings, then run **Connections → Check & discover companies**. A browser response alone proves reachability; an actual XML read and comparison with the same company/reporting period are needed to validate data. The official guide makes this distinction. [Tally request verification](https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/)

Tally's newer guide says native JSON integration starts with Release 7.0. Stockbridge currently uses XML; that statement does not establish a minimum supported Tally version for this adapter. Live compatibility and stock/report semantics still require verification. [Tally format/version guidance](https://help.tallysolutions.com/building-tunnel-based-connectivity-for-tallyprime-integrations/)

## Flipkart: choose the correct authorization model

Seller login does not grant API access. Seller self-access details must not be shared with providers; providers managing sellers need third-party applications. [Application registration](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration)

| Operator       | Documented registration                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller         | Manage Profile → Developer Access → Create New Access; enter name/description and submit.                                                                                           |
| Partner/vendor | Register at the partner portal as an API partner; await verification. Then Profile → Manage API Access → Create Application; supply name, description and valid HTTPS callback URL. |

[Flipkart registration steps](https://seller.flipkart.com/api-docs/FMSAPI.html#application-registration)

Self-access uses Basic authentication with the application ID/secret to request a token using `client_credentials`. Third-party onboarding sends the seller through Flipkart's authorization page (`Seller_Api` scope); the seller reviews and allows access. Validate returned `state`, then exchange the code using application credentials. Use HTTPS, protect tokens, and implement expiry/renewal. [Token flows](https://seller.flipkart.com/api-docs/FMSAPI.html#generating-access-tokens)

The guide does not establish separate inventory-read/order-read/inventory-write permission switches. Review actual consent; verify returned scope/expiry fields. [Authentication examples](https://seller.flipkart.com/api-docs/FMSAPI.html#generating-access-tokens)

Application label proposal: **Stockbridge - HingadTyre**. Registering it and accepting permissions are future customer/provider actions, after the operating model is decided. A local dashboard address is not by itself the HTTPS callback required for a third-party application. Provider callback and protected credential-storage design remain implementation decisions.

Flipkart's separate API Hub includes sandbox-host examples while the seller documentation shows production-host examples. Choose one intended environment deliberately; do not paste samples indiscriminately. Seller registration alone does not provide sandbox access; API questions can be raised through the seller/partner portal's API GA support route. [API Hub examples](https://flipkart.github.io/fk-api-platform-docs/docs/intro), [Flipkart FAQ](https://seller.flipkart.com/api-docs/FAQ.html)

## What the repository currently implements

- The Tally URL validator allows only `127.0.0.1`, `localhost` and IPv6 loopback, with no credentials/path/query/fragment. The backend also binds to `127.0.0.1`. Same-computer installation is therefore a current application constraint, not a claim that Tally itself cannot support a private network. [Tally adapter](../../src/adapters/tally.ts), [backend startup](../../src/server/main.ts)
- The backend stores live/sample state separately under `.data`; it does not yet use a Windows installation data directory. `/api/publish` explicitly returns an unavailable error. Authenticated Flipkart onboarding/import, durable publication and recovery remain delivery work. [Backend startup](../../src/server/main.ts), [HTTP routes](../../src/server/http.ts), [current delivery status](../../README.md)
- The adapter's first stock view is company-wide. Company identifiers, balance period, base units, godowns, marketplace locations and per-listing pack evidence must be verified before publication. Browser evidence for one listing is insufficient to validate all mappings. [Customer setup](../customer-setup.md), [Flipkart validation](flipkart-validation.md)

## Customer facts still needed

- Installed Tally product/release, selected company identity, base units, source godowns and normal reporting period.
- Whether HingadTyre operates its own installation or a provider manages API access on its behalf; resulting Flipkart application model and callback owner.
- Actual API eligibility, authorization screen, authenticated seller/location identifiers and response evidence for each mapping.
- Windows account/service ownership, installation data directory, backup destination and verified restore/support procedure.

No account was registered, permission accepted, secret retrieved or customer system changed during this research.
