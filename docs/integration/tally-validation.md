# Tally read-only adapter validation

This milestone only exports company and stock-item data. It never imports, creates, edits or deletes Tally records. The adapter uses a local HTTP listener and rejects redirects and non-loopback destinations.

The request shape follows Tally's documented [XML envelope, collection export and static variables](https://help.tallysolutions.com/xml-integration/). The [collection XML examples](https://help.tallysolutions.com/how-to-write-remote-compliant-tdl-reports-in-tdl/) use `NATIVEMETHOD` for fetched fields and `METHOD` for computed values. [Third-party extraction](https://help.tallysolutions.com/integration-initiated-from-tpas/) documents HTTP/XML collection access and the usual port 9000. [Inventory master examples](https://help.tallysolutions.com/sample-xml/) document stock-item base units. These sources establish the general interface, not successful integration with the user's installed Tally version.

The code asks for company and item GUIDs, which must be verified for stability across rename, restore and reconnect on the installed version. Missing or duplicate GUIDs block the import. Names are display values and are used only for the required `SVCURRENTCOMPANY` scope, never as internal identities.

Stock export sets `SVCURRENTCOMPANY` and `SVTODATE` (today in the local machine's calendar). An embedded computed field, `StockbridgeCompanyGuid : $GUID:Company:##SVCurrentCompany`, projects the selected company GUID onto each stock row and must match the requested GUID. Company discovery also runs before and after the export. If that projection is unavailable or a company identity changes, the adapter refuses the read. These checks are not an atomic snapshot of a changing Tally session.

The tests exercise real local HTTP requests against constructed XML fixtures: successful scoped reads, changed company identity, missing GUIDs, empty versus missing data, unknown compound quantities, malformed responses, Tally errors, timeouts, redirects, UTF-16 and response-size limits. They establish adapter behaviour under those fixtures. No test currently proves the projection or closing-balance period semantics against a running Tally installation.

Before enabling publication, verify the request and returned fields on the real installation; compare quantities with the same company and date in Tally; confirm how edits, deletions, receipt notes and stock adjustments affect closing balances; inspect base units and compound quantities; and implement explicitly selected godown extraction. This first read is company-wide stock only. A company-wide balance is not evidence for a particular godown or marketplace location.

Blank, unsupported or mismatched units produce an unknown quantity (`null`), not zero. Missing or invalid envelopes reject the complete read so the application can preserve its last valid observation. Negative numeric stock is preserved as source data; the separate stock policy decides its advertised effect.
