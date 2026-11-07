# Working on Stockbridge

This is a conventional React and TypeScript application with a local Node.js backend and SQLite. A developer should be able to understand a change from the source, tests and these documents without this project's chat history.

The current build reviews inventory and exports Tally data read-only. Marketplace publishing remains disabled. See [README](README.md) for the delivered scope and [customer setup](docs/customer-setup.md) for HingadTyre installation steps. Tally does not need to run on the development machine.

Before implementation, follow the [documentation workflow](docs/agents/documentation.md) to select the relevant requirements, decisions and integration evidence. Use the same workflow to update affected docs alongside the change and record the documentation impact at handoff.

## Start with the sample workspace

Use Node.js 24 and install the pinned dependencies with `npm ci`. Then:

```sh
npm run build
npm run demo
```

Open `http://127.0.0.1:4311`. Sample data lives in `.data/demo.sqlite`, separate from the customer's live database. Keep one server running per workspace. Stop the server with Ctrl+C before changing the database schema or restarting with a new build.

On this Windows development computer, the project-local Node runtime can be selected without changing the global installation:

```powershell
.\scripts\app.ps1 -Mode Build
.\scripts\app.ps1 -Mode Demo
```

For frontend development, keep `npm run demo` running in one terminal and run `npm run dev` in another. Vite's `/api` proxy targets the sample backend on port 4311. Changes to frontend files reload automatically; backend changes require rebuilding and restarting the sample server.

## Where to make a change

| Change                                         | Start here                                                 |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Navigation and shared page frame               | `src/client/App.tsx`                                       |
| Inventory table, filters, drafts or review     | `src/client/screens/` and `src/client/selectors.ts`        |
| Activity, connections or settings presentation | The corresponding screen under `src/client/screens/`       |
| Reused buttons, dialogs and formatting         | `src/client/components.tsx` and the focused client helpers |
| Request routes and public error responses      | `src/server/http.ts`                                       |
| Inventory commands and proposal validation     | `src/server/service.ts` and its inventory helpers          |
| Physical stock and Flipkart tyre arithmetic    | `src/domain/stock-policy.ts`                               |
| Allowance consumption arithmetic               | `src/domain/allowance.ts`                                  |
| Reading Tally XML                              | `src/adapters/tally.ts`                                    |
| Importing stock observations                   | `src/server/stock-refresh.ts`                              |
| Poll timing, overlap and backoff               | `src/server/polling.ts`                                    |
| Diagnostic files and internal error details    | `src/server/diagnostics.ts`                                |
| Settings and verified backups                  | `src/server/settings.ts`, `src/server/backups.ts`          |
| Database transactions and records              | `src/server/store.ts`, `src/server/storage/`               |
| Creating and connecting backend modules        | `src/server/main.ts`                                       |
| Shared request/result records                  | `src/shared/contracts.ts`                                  |

## Trace one stock change

1. The Tally adapter reads a company-scoped stock item and validates its external identifiers. The stock-refresh module saves an observation through the store. No Tally records are written.
2. The dashboard reads an application snapshot through `/api/state`. The snapshot is a view assembled from stored records; it is not the database schema.
3. **Calculate** sends an explicit company and listing-ID set to `/api/calculate`. The server validates the source and mapping, then calls `calculateStock`.
4. `completePacks` converts physical base units into complete packs. `applyFlipkartTyreFloor` applies the seller-approved zero-or-at-least-five rule. The active allowance or hold further limits the result.
5. The result is saved as a proposal with source and policy versions. Editing a proposed number saves a draft, not an active policy. A later source change makes that draft stale.
6. **Review** returns only the captured listing destinations. Publishing is currently rejected by the server. Completing a local request must never be presented as a confirmed Flipkart change.

Example: four physical tyres can supply two pairs. The agreed advertising rule proposes five for that pair listing. A manual draft of one represents a future allowance of one listing unit; saving that draft alone neither changes observed stock nor activates the allowance.

## Preserve the business rules

Read [GLOSSARY](GLOSSARY.md) for names and [the approved architecture](docs/design/architecture.md) for decisions. In particular:

- Companies never share stock by matching names.
- Unknown stock stays unknown; read failure must not become zero.
- Pack arithmetic and marketplace advertising policy remain separate.
- Selected listings take precedence over filters. A disappeared selection must not expand an action to every remaining listing.
- Pause and stock policy are separate. Pausing preserves an allowance or zero hold.
- Only an approved order for the exact listing can consume its allowance. Purchases and cancellations do not refill it automatically.
- No source refresh, retry or draft edit silently enables marketplace publishing.

## Code should explain itself

- Use business names from the glossary. Prefer an explicit function name over a boolean argument whose meaning the caller must guess.
- Keep each screen's state near that screen. Keep transport, scheduling and filesystem work out of the stock-rule functions.
- Use ordinary functions and explicit types. Add another module when it owns a coherent responsibility, rather than moving every helper into a separate file.
- Comments explain a business constraint or a non-obvious recovery decision. Avoid comments that repeat the next statement.
- Make asynchronous success and failure visible to callers. A dialog closes only after its requested action succeeds.
- Keep public errors simple; preserve sanitized internal causes and request identifiers in Diagnostics. Never log credentials or full customer payloads.
- Keep customer-specific rules named and scoped. HingadTyre's tyre-pack assumptions must not become an implicit rule for every future marketplace.

## Run the checks

```sh
npm run format
npm run verify
```

`format` applies the checked-in Prettier rules. `verify` checks formatting, runs ESLint, compiles and runs tests, then builds the dashboard. The same checks are configured for GitHub Actions. They do not contact Tally or Flipkart: external responses are exercised through local fixtures or injected test readers.

Tool versions are pinned together: TypeScript 6.0 is supported by the selected TypeScript ESLint release. The `minimatch` override selects the patched matcher used by lint tooling for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Recheck and remove that override when the upstream tools depend on the patched release themselves; run the full checks after dependency changes.

Windows with the project-local runtime:

```powershell
.\scripts\app.ps1 -Mode Format
.\scripts\app.ps1 -Mode Verify
```

Add a regression for behaviour that could break: wrong company scope, discarded draft, duplicate allowance consumption, failed migration, overlapping polls or lost error information. Test outcomes through the module's normal interface. Formatting-only changes do not need their own tests.

## Evolve the database safely

Keep schema definitions, record conversion and version upgrades in `src/server/storage/`. Add a numbered migration for a schema change; never reinterpret old rows just by changing a TypeScript interface. Validate legacy data before conversion, preserve a verified pre-upgrade backup, and apply the migration transactionally. Test both successful upgrades and failures that leave the old data intact.

Orders, durable publication jobs and production restore recovery are still future features. Define their records and transaction rules when implementing them. The current migration is not an implementation of those workflows.
