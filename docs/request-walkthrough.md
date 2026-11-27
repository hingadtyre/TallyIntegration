# From a dashboard action to SQLite and back

Read [Development basics](development-basics.md) first for variables, functions, TypeScript, React state, hooks and asynchronous requests. This walkthrough connects those concepts to the current source. The examples describe requests; they were not executed against a customer's workspace.

This walkthrough follows the local dashboard from its saved snapshot through reviewed stock publication. The [README](../README.md) records delivery status, [CONTRIBUTING](../CONTRIBUTING.md) covers run commands, and [the architecture](design/architecture.md) describes the product rules.

**1. The browser, backend and database are different things**

The browser runs the React interface. The backend is a separate Node.js program running on the same computer. SQLite is the database library used by that backend to read and write a local file. A backend does not have to be hosted on the internet.

An API is an interface a program exposes to another program. Here the browser sends HTTP requests to paths such as `/api/state`. HTTP requests identify a destination, an operation called a method, optional headers describing the message, and sometimes a body containing data. The backend returns a response with a status, headers and a body.

For the default built Demo application, the address is `http://127.0.0.1:4311`:

- `http` is the communication protocol.
- `127.0.0.1` means this computer.
- `4311` is the port, which identifies the listening application on that computer.
- `/api/state` is a path handled by that application.

The configured default Live port is 4310. Startup and listening are in [runtime.ts](../src/server/runtime.ts#L188). The initial browser HTML/JavaScript/CSS and the later data request are separate requests; [http.ts](../src/server/http.ts#L110) serves the built page assets.

If using the Vite development page, `/api/state` is first requested from the address printed by Vite. The `/api` proxy in [vite.config.ts](../vite.config.ts#L6) forwards it to the Demo backend at `http://127.0.0.1:4311`. The backend must already be running. See [the development workflow](../CONTRIBUTING.md#build-and-reload-behavior).

```text
Browser: React
  -> HTTP request
Local backend: Node.js
  -> SQL statements through node:sqlite
Database file: demo.sqlite
  -> database records
Local backend: JavaScript object -> JSON text
  -> HTTP response
Browser: parsed object -> React state -> visible rows
```

**2. The first page load triggers a data request**

[index.html](../index.html#L9) supplies a root element and the browser entry script. [main.tsx](../src/client/main.tsx#L6) starts React, which renders [App](../src/client/App.tsx#L12). App calls `useWorkspace()` and initially receives `state = null`, so it displays the opening message.

After the UI is committed, the effect in [useWorkspace.ts](../src/client/useWorkspace.ts#L20) starts its initial load. Its request is:

```ts
const next = await requestJson<Snapshot>('/state', undefined, abort.signal);
```

`requestJson` is our function. `/state` is its path argument. `undefined` means there is no body, while preserving the third argument position for the cancellation signal. `Snapshot` describes the expected result to TypeScript; it does not read the database. `await` waits within this asynchronous function for the request to succeed or fail. `next` will contain the returned data on success.

The request helper in [api.ts](../src/client/api.ts#L8) supplies `/api` before the path:

```ts
const response = await fetch(
  `/api${path}`,
  body === undefined
    ? { signal }
    : {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stockbridge-Request': '1',
        },
        body: JSON.stringify(body),
        signal,
      },
);
```

The backtick string is a template literal: `${path}` inserts the value of `path`. `/api` plus `/state` becomes `/api/state`. The condition chooses the first options object because no body was supplied. `fetch` therefore uses its default method, GET. The signal is a local cancellation option, not a field sent in the JSON body. See [the browser Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).

The application-level request is equivalent to the following. The browser adds other normal HTTP headers; this example is not a packet capture:

```http
GET /api/state HTTP/1.1
Host: 127.0.0.1:4311
```

There is no request body and no selected-company parameter. This endpoint returns all saved companies; the interface filters what it displays. Commands that change records separately validate company scope.

**3. How the backend knows which database to read**

Startup explicitly wires these objects together in [runtime.ts](../src/server/runtime.ts#L188):

```ts
store = new Store(join(owner.dataDirectory, `${mode}.sqlite`), mode);
service = new InventoryService(store, { diagnostics });
```

The following call passes `service` into `createApp`, the HTTP server factory in [http.ts](../src/server/http.ts#L127).

A class describes objects with related data and functions. `new Store(...)` creates one store object and runs its constructor. The path passed to it determines the database file. `new InventoryService(store, ...)` gives the service access to that same store. The objects are explicitly passed along; their names do not automatically connect them.

Inside [Store's constructor](../src/server/store.ts#L16), this statement opens the SQLite database:

```ts
this.database = new DatabaseSync(file);
```

`DatabaseSync` is imported from Node's built-in `node:sqlite` module. `file` is the path supplied to the constructor. `this.database` stores the database connection on this Store object. A function belonging to an object is called a method: `store.read()` calls the store's `read` method. SQLite is embedded in the backend; no separate Oracle or PostgreSQL server is required for this local design. See [the architecture decision](adr/0002-local-typescript-sqlite.md) and [SQLite's application-storage guidance](https://www.sqlite.org/whentouse.html).

**4. The route calls the service, which calls the store**

The request reaches this condition in [http.ts](../src/server/http.ts#L150):

```ts
if (request.method === 'GET' && path === '/api/state')
  return sendJson(response, 200, service.snapshot());
```

`&&` requires both conditions to be true. JavaScript evaluates `service.snapshot()` to obtain the data before calling `sendJson` with that data. `200` is the HTTP success status. These are JavaScript function calls, not SQL statements.

The service method in [service.ts](../src/server/service.ts#L57) is:

```ts
snapshot(): Snapshot {
  const state = this.store.read();
  state.proposals.forEach((draft) => {
    draft.stale = isStaleProposal(state, draft);
  });
  return state;
}
```

`this.store` is the store provided during startup. `read()` obtains saved data. `forEach` visits the returned proposals to recompute whether their saved source versions are outdated. `return state` passes the resulting object back to the caller. The returned object's stale flags are computed for this response; this GET does not persist those changed flags.

The `: Snapshot` after the method name is a TypeScript return-type annotation. The actual read happens because `this.store.read()` executes, not because the return type is named Snapshot.

**5. Where actual SQL executes**

[Store.read](../src/server/store.ts#L39) calls `readSnapshot(this.database)` within a transaction. `BEGIN` starts it, `COMMIT` finishes it successfully, and `ROLLBACK` handles failure. The transaction keeps the component reads consistent with one committed database state.

[readSnapshot](../src/server/storage/records.ts#L20) issues SQL queries. This is the actual stock-item query:

```ts
const items = database
  .prepare(
    `
  SELECT id, company_id AS companyId, external_id AS externalId, name, brand, unit,
    physical, observed_at AS observedAt, version, low_stock_threshold AS lowStockThreshold
  FROM stock_items ORDER BY sort_order
`,
  )
  .all();
```

Source: [records.ts](../src/server/storage/records.ts#L51).

The outer code is TypeScript/JavaScript. The text inside the backticks is SQL, the language used to query the database:

- `SELECT` identifies the columns to retrieve.
- `FROM stock_items` identifies the table.
- `AS companyId` names the returned property `companyId` although the stored column is `company_id`.
- `ORDER BY sort_order` orders the results by the saved ordering field.
- `.prepare(...)` prepares the SQL statement.
- `.all()` executes the statement and returns its rows as an array of objects.

A table contains rows and named columns. One stock-item row holds one item's identifiers, name, physical quantity and observation information. Table definitions are in [schema.ts](../src/server/storage/schema.ts#L28).

The same reader retrieves metadata, settings, connection status, companies, seller accounts, listings, proposals and activity. It then assembles and validates the result in [records.ts](../src/server/storage/records.ts#L95). The API snapshot combines several tables; there is no single `Snapshot` SQL table.

**6. How rows become visible text**

[sendJson](../src/server/http.ts#L54) produces the response:

```ts
response.writeHead(status, {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});
response.end(JSON.stringify(data));
```

This is the source expression reformatted across lines. `JSON.stringify` converts the backend's object into JSON text. `Content-Type` describes that text format. `no-store` tells caches not to retain this response. `response.end` sends the body and finishes the response.

An illustrative response excerpt is shown below. It omits required fields and other records for teaching; it is not a complete Snapshot or a captured customer response:

```json
{
  "items": [
    {
      "id": "item-a",
      "companyId": "demo-a",
      "name": "CEAT Milaze X3",
      "physical": 4
    }
  ],
  "proposals": []
}
```

The browser converts the JSON response back into a JavaScript value with `await response.json()` in [api.ts](../src/client/api.ts#L28). The helper checks HTTP success and returns the parsed result. Its `as T` assertion is not runtime schema validation.

[useWorkspace.ts](../src/client/useWorkspace.ts#L30) accepts a current response and calls `setState(next)`. React renders App again with the new state. [App](../src/client/App.tsx#L174) passes it into Inventory. [InventoryScreen](../src/client/screens/InventoryScreen.tsx#L55) filters and groups its items, then renders [ItemRows](../src/client/screens/InventoryScreen.tsx#L341). Finally [InventoryTable](../src/client/screens/InventoryTable.tsx#L71) reads `item.physical` and formats it for display.

Receiving JSON does not automatically create table rows. These explicit component expressions connect each data field to visible markup.

**7. One complete write request: save a draft of 1**

Assume a valid sample listing already has a calculated proposal of 5. The user changes its proposed quantity to 1. Typing changes the editor's local string value only. Submitting the form in [QuantityEditor](../src/client/screens/QuantityEditor.tsx#L32) validates the text and calls `onSave(Number(value))`.

[InventoryTable](../src/client/screens/InventoryTable.tsx#L146) supplies the listing identity. [InventoryScreen](../src/client/screens/InventoryScreen.tsx#L360) supplies the company and sends:

```ts
mutate(
  '/proposals',
  { companyId, listingId: listing.id, quantity: amount },
  'Saving draft',
  'Draft saved. Review it before publication; the active policy has not changed.',
);
```

`mutate` delegates the operation and feedback to `runAction` in [useWorkspace.ts](../src/client/useWorkspace.ts#L50). Because the request has a body, [api.ts](../src/client/api.ts#L18) chooses POST and converts that body to JSON.

An illustrative request using the fresh demo IDs is:

```http
POST /api/proposals HTTP/1.1
Host: 127.0.0.1:4311
Content-Type: application/json
X-Stockbridge-Request: 1

{"companyId":"demo-a","listingId":"listing-2","quantity":1}
```

The browser adds its normal headers. The custom `X-Stockbridge-Request` header is a local request check, not a Flipkart access token or user password. [The server](../src/server/http.ts#L59) checks dashboard headers/origin, parses the JSON body and routes the request to `service.edit(...)` through [the command dispatcher](../src/server/http.ts#L86).

[The edit service](../src/server/service.ts#L104) validates the quantity, listing ownership and source stock. It checks the requested quantity against the permitted calculation and prepares a versioned proposal. An invalid request returns an error rather than saving an arbitrary amount.

The mutation runs inside [Store.update](../src/server/store.ts#L51):

```text
BEGIN IMMEDIATE
  -> read current records
  -> run the service's validated change
  -> write changed records
COMMIT
```

If any step throws an error, the store rolls back the transaction. [writeSnapshot](../src/server/storage/records.ts#L252) converts proposal properties to SQL column values. Its [syncTable helper](../src/server/storage/records.ts#L111) inserts or updates changed rows using bound parameters (`?`), rather than inserting the user's text into SQL. It also persists the activity entry. Unchanged rows are not rewritten.

After the commit, the service returns a new snapshot. The server serializes it; the browser parses it; [mutate](../src/client/useWorkspace.ts#L79) calls `setState(next)`; and the proposal editor displays the saved quantity. Its [key](../src/client/screens/InventoryTable.tsx#L142) incorporates the new proposal timestamp so its local input initializes from the saved version.

Typing changes a local input. Saving writes the proposal to SQLite. **Review changes** captures the selected destinations and row versions. Choosing **Publish** sends the captured, eligible quantities to the marketplace writer. Sample mode simulates that final step locally.

**8. Dashboard action to request map**

Bodies below use JavaScript shorthand. For example, `{companyId}` means an object with a `companyId` property whose value comes from the current selection. JSON sent over HTTP quotes property names. Ordinary commands use the POST headers shown above. All `/api/...` addresses are relative to the current dashboard origin, with the Vite proxy used during frontend development.

| Action and client source                                                        | Method and path                            | Body                                                                                                                        | Result                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Refresh inventory](../src/client/useWorkspace.ts)                              | POST `/api/inventory/refresh`              | `{companyId?, accountId?}`                                                                                                  | Snapshot with `refresh: {message, partial}`                            |
| [Discover companies](../src/client/screens/ConnectionsScreen.tsx)               | POST `/api/refresh`                        | `{}`                                                                                                                        | Snapshot after discovery attempt                                       |
| [Calculate](../src/client/screens/InventoryScreen.tsx)                          | POST `/api/calculate`                      | `{companyId, listingIds}`                                                                                                   | Snapshot and per-listing ready, preserved or blocked results           |
| [Set to zero](../src/client/screens/InventoryScreen.tsx)                        | POST `/api/zero`                           | `{companyId, listingIds}`                                                                                                   | Snapshot with zero proposals                                           |
| [Save draft](../src/client/screens/InventoryScreen.tsx)                         | POST `/api/proposals`                      | `{companyId, listingId, quantity}`                                                                                          | Snapshot with saved proposal                                           |
| [Pause/resume one listing](../src/client/screens/InventoryScreen.tsx)           | POST `/api/pause`                          | `{companyId, listingIds, paused}`                                                                                           | Snapshot with saved listing pause state                                |
| [Preview company sync](../src/client/screens/AutomationDialog.tsx)              | POST `/api/automation/preview`             | `{companyId}`                                                                                                               | Single-use review of all mapped accounts and locations                 |
| [Enable or turn off company updates](../src/client/screens/InventoryScreen.tsx) | POST `/api/automation`                     | `{companyId, enabled, previewId}` to enable, `{companyId, enabled: false}` to turn off                                      | Snapshot with the company setting                                      |
| [Try one listing](../src/client/screens/AutomationDialog.tsx)                   | POST `/api/automation/trial`               | `{companyId, listingId, previewId}`                                                                                         | Publication result for the approved location                           |
| [Review](../src/client/useWorkspace.ts)                                         | POST `/api/review`                         | `{companyId, listingIds}`                                                                                                   | Captured review with ID and per-row checks                             |
| [Publish](../src/client/useWorkspace.ts)                                        | POST `/api/publish`, then GET `/api/state` | `{reviewId, positiveEdits?}`                                                                                                | Outcomes by listing destination, then an updated snapshot              |
| [Save mapping or Set of](../src/client/screens/MappingDialog.tsx)               | POST `/api/mappings`                       | `{listingId, itemId, listingVersion, expectedUnit, packSource, packSize, sourceScope, tyreFloor, confirmPackEvidence:true}` | Snapshot with the confirmed stock conversion for this listing location |
| [Unlink](../src/client/screens/InventoryScreen.tsx)                             | POST `/api/mappings/remove`                | `{companyId, listingId, leaveRemoteStock:true}`                                                                             | Snapshot with mapping removed                                          |
| [Save settings](../src/client/screens/SettingsScreen.tsx)                       | POST `/api/settings`                       | `{settings}`                                                                                                                | Snapshot with saved configuration                                      |
| [Back up now](../src/client/useWorkspace.ts)                                    | POST `/api/backup`, then GET `/api/state`  | `{}` for POST                                                                                                               | `{path, verified:true}`, then the updated snapshot                     |
| [Read/follow/export diagnostics](../src/client/screens/ActivityScreen.tsx)      | GET `/api/logs`                            | None                                                                                                                        | Plain text from the diagnostic file                                    |

The [HTTP dispatcher](../src/server/http.ts) delegates these commands to the [Inventory service](../src/server/service.ts). A review is a short-lived, single-use capture in memory. Publishing checks the review again against the latest mapping, source, proposal and destination. The [publication rules](../src/server/inventory-publication.ts) distinguish a normal calculation, a manually entered zero that pauses the destination, and a positive manual edit. For positive edits the client can send `positiveEdits: 'once'` to set the absolute amount on an Auto listing. The `'allowance'` choice requests a finite sales allowance and is blocked in live mode until order reconciliation is available.

The [Review dialog](../src/client/screens/InventoryDialogs.tsx) stays open to report each listing's confirmed, unchanged, blocked, failed or uncertain outcome. The selected company, seller account, filters, checkboxes, row collapse and listing history are local views of the snapshot. The diagnostics screen polls every five seconds while Follow is active. Failed discovery returns retained observations with an offline status. When just one company stock export fails, its own status explains why its saved balance is waiting while other companies can continue. The [client](../src/client/useWorkspace.ts) displays that status and its cause.

**9. Reading saved data and refreshing inventory**

`GET /api/state` reads the local database. The browser requests it every 15 seconds when idle. In Connections, **Check & discover companies** calls `POST /api/refresh` to discover the loaded Tally companies and read their stock. [Client refresh actions](../src/client/useWorkspace.ts) · [Tally stock reader](../src/server/stock-refresh.ts)

In Inventory, **Refresh inventory** calls `POST /api/inventory/refresh`. The selected company’s mappings and billing setup identify its participating sellers. The request also includes an explicitly selected seller when eligible. Stockbridge refreshes those catalogues, uses an import already running for the seller when possible, and reads Tally stock. If the company has confirmed starting stock, it checks orders and reservations. The command can publish eligible pending stock changes under the existing company sync and listing rules. The response includes the updated snapshot and a `refresh` object with a message and a `partial` flag for checks that need attention. [Inventory service](../src/server/service.ts) · [Seller catalogue imports](../src/server/marketplace-service.ts)

New workspaces schedule **Tally stock** every minute, **Marketplace orders** every five minutes and **Listings** every hour. Saved intervals persist across upgrades. **Marketplaces > Refresh listings** also imports one seller’s catalogue on demand. Demo mode uses sample data. [Workspace defaults](../src/server/seed.ts)

**10. Viewing the database yourself**

Yes, the records can be inspected in a database viewer. This project uses SQLite files. [DB Browser for SQLite](https://sqlitebrowser.org/) is a graphical viewer/editor with a table browser and SQL query facility. It opens a SQLite file directly; an Oracle database connection is not required.

The source-checkout default paths are `.data/demo.sqlite` and `.data/live.sqlite` under the application root. [Runtime path resolution](../src/server/runtime.ts#L33) derives that root from the compiled application location, not from an arbitrary terminal working directory. `STOCKBRIDGE_DATA_DIR` can override the directory. The packaged launcher normally uses `%LOCALAPPDATA%\Stockbridge\Pilot\data`; see [launcher.ts](../src/desktop/launcher.ts#L80). These are configured defaults, not proof that a particular file or running instance exists.

For a learning exercise:

1. Use the Demo workspace described in [CONTRIBUTING](../CONTRIBUTING.md#start-with-the-sample-workspace).
2. In Settings, use **Back up now**. The success message supplies the verified backup's path. This action also captures committed changes when SQLite uses its write-ahead log.
3. Open the resulting `.sqlite` backup in DB Browser for SQLite, preferably read-only. Its `.json` companion is backup metadata, not the database to open.
4. Inspect `companies`, `stock_items`, `listings` and `proposals` in the table browser. Use the SQL editor for a query such as the following.

Illustrative read-only SQL, not executed for this document:

```sql
SELECT id, company_id, name, physical
FROM stock_items
ORDER BY name;

SELECT listing_id, quantity, calculated, edited, created_at
FROM proposals
ORDER BY sort_order;
```

The first query shows saved physical observations. The second shows saved proposals; `edited = 1` records a manual edit. A backup is a point-in-time copy, so it will not change when the live application later saves something.

Use the backup for inspection rather than changing the active workspace file. [The customer guide](customer-setup.md) explains the database and `-wal`/`-shm` companion files; do not delete or separate those companions while Stockbridge is running. Direct SQL edits bypass the application's validation, version changes and activity recording.

**11. Watching a request in the browser**

In the running Demo dashboard, open the browser's developer tools, select the Network panel, and filter for `/api/`. Reload the page to see `/api/state`. Inspect its request URL, method, status and response. Then use Calculate or save a sample proposal and inspect the corresponding POST payload and returned Snapshot.

This inspection shows actual HTTP messages. It does not show the backend's SQL statements; those are traced through [http.ts](../src/server/http.ts), [service.ts](../src/server/service.ts), [store.ts](../src/server/store.ts) and [records.ts](../src/server/storage/records.ts). Keeping those responsibilities separate allows the UI, stock policy and persistence to be understood and changed independently.
