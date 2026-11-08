# Working on Stockbridge

This is a conventional React and TypeScript application with a local Node.js backend and SQLite. A developer should be able to understand a change from the source, tests and these documents without this project's chat history.

The current build reviews inventory and exports Tally data read-only. Marketplace publishing remains disabled. See [README](README.md) for the delivered scope and [customer setup](docs/customer-setup.md) for HingadTyre installation steps. Tally does not need to run on the development machine.

Before implementation, follow the [documentation workflow](docs/agents/documentation.md) to select the relevant requirements, decisions and integration evidence. Use the same workflow to update affected docs alongside the change and record the documentation impact at handoff.

## Start with the sample workspace

Use Node.js 24 and the npm scripts in [package.json](package.json) as the normal development commands. Install the pinned dependencies with `npm ci`. Then, from the project root in PowerShell or a compatible shell:

```sh
npm run build
npm run demo
```

Open `http://127.0.0.1:4311`. Sample data lives in `.data/demo.sqlite`, separate from the customer's live database. Keep one server running per workspace. Stop the server with Ctrl+C before changing the database schema or restarting with a new build.

The optional Windows launcher, [scripts/app.ps1](scripts/app.ps1), selects the project-local Node runtime when available and delegates to the same npm scripts. Use it when intentionally selecting that runtime; prefer npm directly when the terminal already uses Node.js 24. The launcher neither installs dependencies nor rebuilds before starting.

## Build and reload behavior

`npm run build` compiles TypeScript and builds the browser dashboard. `npm start` and `npm run demo` execute the compiled server in `dist` and serve the built dashboard in `dist/web`. Neither run command rebuilds or watches source files, so starting without rebuilding uses the previous build.

For backend changes, stop the running backend with Ctrl+C, run `npm run build`, and restart it with `npm run demo` after the build succeeds. Use `npm start` instead only for the intended real workspace. Keep one backend per database running. The database survives a normal stop/restart.

For frontend editing, keep the built Demo backend running in one terminal, and run `npm run dev` in a second terminal. Open the address printed by Vite. Frontend changes reload there automatically; opening port 4311 instead shows the built dashboard, not the development page. Vite forwards `/api` requests to the Demo backend on port 4311, as configured in [vite.config.ts](vite.config.ts).

`npm run dev` watches only the frontend. Backend changes, including shared code used by the backend, still need a build and backend restart. When checking the built dashboard after frontend-only changes, rebuild and refresh the browser. Stop each running development process with Ctrl+C in its own terminal.

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

- Use a plain hyphen (`-`) for separators and empty-value placeholders in UI text, previews and documentation. Avoid em dashes; use a colon, comma or full stop when clearer.
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

Add a regression for behaviour that could break: wrong company scope, discarded draft, duplicate allowance consumption, failed migration, overlapping polls or lost error information. Test outcomes through the module's normal interface. Formatting-only changes do not need their own tests.

## Test organization and scope

Keep the current tools: Node's `node:test` runner and `node:assert/strict` for all tests, with React Testing Library and jsdom for frontend interactions. Test files mirror their primary source module under `tests/`:

| Source module                           | Test file                                      |
| --------------------------------------- | ---------------------------------------------- |
| `src/domain/stock-policy.ts`            | `tests/domain/stock-policy.test.ts`            |
| `src/domain/allowance.ts`               | `tests/domain/allowance.test.ts`               |
| `src/adapters/tally.ts`                 | `tests/adapters/tally.test.ts`                 |
| `src/server/service.ts`                 | `tests/server/service.test.ts`                 |
| `src/server/storage/migrations.ts`      | `tests/server/storage/migrations.test.ts`      |
| `src/client/App.tsx`                    | `tests/client/App.test.tsx`                    |
| `src/client/screens/QuantityEditor.tsx` | `tests/client/screens/QuantityEditor.test.tsx` |

Keep cross-module scenarios with the entry point being exercised: HTTP routes with `http`, database transactions with `store`, and full dashboard interactions with `App`. Reusable test setup belongs in `tests/support/`. A source file does not need a separate test just to exist; test meaningful public behavior and avoid duplicating cases already covered through a caller. Use descriptive scenario names, with normal operation, important validation and recovery cases where relevant. The test files are the scenario list; do not maintain a second case-by-case catalog in documentation.

From the project root in PowerShell or a compatible shell:

```sh
npm test
npm test -- tests/client
npm test -- tests/domain/stock-policy.test.ts
```

These are alternative commands: run everything, the frontend folder, or one mapped source test. `npm test` compiles the TypeScript first; the small [test launcher](scripts/run-tests.mjs) then maps current test source paths to compiled JavaScript and invokes Node's test runner. It ignores stale compiled copies of moved/deleted tests and fails if a requested path matches no test sources. Keep the npm script as the entry point so tests never accidentally run against an old build.

Frontend tests simulate browser interactions in jsdom. Backend tests use isolated temporary databases and local HTTP fixtures; they do not read customer data or contact real Tally/Flipkart services. Coverage of the current foundation is not evidence that unfinished marketplace publishing, customer authorization, installer or production restore flows work. Add their behavior tests when implemented, and retain the customer integration checks before activation.

## Evolve the database safely

Keep schema definitions, record conversion and version upgrades in `src/server/storage/`. Add a numbered migration for a schema change; never reinterpret old rows just by changing a TypeScript interface. Validate legacy data before conversion, preserve a verified pre-upgrade backup, and apply the migration transactionally. Test both successful upgrades and failures that leave the old data intact.

Orders, durable publication jobs and production restore recovery are still future features. Define their records and transaction rules when implementing them. The current migration is not an implementation of those workflows.
