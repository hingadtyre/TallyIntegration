# Development basics: reading the Stockbridge frontend

This note builds the knowledge needed to read [App.tsx](../src/client/App.tsx), [useWorkspace.ts](../src/client/useWorkspace.ts), and [api.ts](../src/client/api.ts). Read it in order, then follow the [request walkthrough](request-walkthrough.md) for the complete browser, HTTP, server, and SQL path, including the API matrix. These explanations describe checked source code. The teaching examples below do not execute requests or read a database.

**1. Start with values and variables.** A value is a piece of information: text such as `'inventory'`, a number such as `15`, or a boolean such as `false`. A variable gives a value a name so code can refer to it.

Simplified teaching example:

```ts
const companyName = 'Example Tyres';
let selectedCount = 0;
selectedCount = 2;
```

`const` prevents assigning a different value to that variable; `let` permits reassignment. The `=` assigns a value. Quotes identify text, also called a string. The semicolon ends a statement. `const` does not automatically freeze the contents of an object.

`null` usually represents an intentional absence, such as “no snapshot loaded yet.” `undefined` often means an argument or value was not supplied. They are different values.

**2. Objects group named information; arrays hold lists.** An object uses braces and property names. An array uses square brackets and ordered entries.

Simplified teaching example:

```ts
const company = { id: 'example-1', name: 'Example Tyres' };
const companies = [company];
const name = company.name;
const firstCompany = companies[0];
```

The object has `id` and `name` properties. A colon separates a property name from its value. `company.name` reads that property. Array positions start at zero, so `[0]` selects the first entry.

JSON is text used to exchange data. A JavaScript object is a value a running program can use. `JSON.stringify(object)` produces JSON text; parsing JSON produces a JavaScript value. JSON does not contain functions. In this project, [api.ts](../src/client/api.ts#L23) serializes outgoing bodies, and `response.json()` parses incoming response text.

**3. Functions define work; calls perform it.** A function declaration names reusable instructions. Parameters name its inputs; arguments are the values supplied when calling it. `return` gives a value back to the caller.

Simplified teaching example:

```ts
function greeting(name: string) {
  return 'Hello ' + name;
}
const message = greeting('Sam');
```

`name` is the parameter; `'Sam'` is the argument. `: string` says the input should be text. The function definition alone does not generate a greeting. The parentheses in `greeting('Sam')` call it, and its result becomes `message`.

A callback is a function passed to another part of the program for it to call. An arrow function is another way to write a function:

```ts
// Simplified teaching example: creates a callback without calling greeting yet.
const greetLater = () => greeting('Sam');
```

In [App.tsx](../src/client/App.tsx#L75), `onClick={() => selectScreen(value)}` supplies a callback. React calls it when the button is clicked. Writing `selectScreen(value)` directly there would call it while calculating the UI.

**4. Destructuring takes values out of a container.** This actual line from [App.tsx](../src/client/App.tsx#L14) reads named object properties:

```ts
const { state, busy, error, notice } = workspace;
```

For example, `state` receives `workspace.state`. It does not independently load state or duplicate the database. The braces select properties by name.

Square brackets select array entries by position. In `const [screen, setScreen] = useState(...)`, the first returned entry becomes `screen` and the second becomes `setScreen`. These variable names are chosen by the author; their positions determine which values they receive.

**5. Imports connect files.** [useWorkspace.ts](../src/client/useWorkspace.ts#L1) starts with:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InventoryPublishResult, Review, Snapshot } from '../shared/contracts.js';
import { errorMessage, requestJson, type ActionResult } from './api.js';
```

The first line imports named functions from the installed React package. The relative paths locate project modules: `./` means the current folder; `../` moves up one folder. This TypeScript project writes `.js` import paths for the JavaScript module files used after compilation.

`export` makes a declaration available to other modules. `import type` imports only a TypeScript description, which is removed from emitted JavaScript. Importing `Snapshot` therefore supplies no actual inventory values. Importing a function makes it available; a call is still needed to perform its work.

**6. A type describes allowed values.** [App.tsx](../src/client/App.tsx#L9) declares:

```ts
type Screen = 'inventory' | 'marketplaces' | 'activity' | 'connections' | 'settings';
```

`type` introduces a type alias named `Screen`. Each quoted value is a string literal type. The `|` means “or,” making this a union of five possible screen names. TypeScript can flag `'orders'` as an invalid `Screen` value.

This declaration creates no buttons and displays no screen. UI code uses the selected value later. Types help check source code before execution; they do not automatically validate external data. See [TypeScript's everyday types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html) for the language rules behind these examples.

**7. An interface describes an object's shape.** This is an excerpt from [contracts.ts](../src/shared/contracts.ts#L77), with other fields omitted:

```ts
export interface Snapshot {
  mode: 'live' | 'demo';
  publishingEnabled: boolean;
  companies: Company[];
  items: StockItem[];
  // Other fields omitted from this excerpt.
}
```

`interface` describes expected properties. `Company[]` means an array of objects matching the separate `Company` interface. The `boolean` type allows `publishingEnabled` to be true or false. The full interface also includes accounts, listings, proposals, activity, settings and connection information. Each listing can carry a confirmed Set of value and its source, which the dashboard reads again after restart.

`Snapshot` is a name chosen for this response shape. Naming a type or variable “snapshot” does not query SQL, load a file, or contact Tally. A real response object needs real code to assemble and send it. The [request walkthrough](request-walkthrough.md) follows that code.

**8. Generics let a function work with different types.** [api.ts](../src/client/api.ts#L8) declares `requestJson<T>(...)`, returning `Promise<T>`. `T` is a placeholder for a type chosen for a particular call. It is not a runtime variable or a special inventory type.

In `requestJson<Snapshot>(...)`, `T` means `Snapshot`. In `requestJson<Review>(...)`, it means `Review`. Publishing a review uses `requestJson<InventoryPublishResult>(...)` because the server returns an outcome for each reviewed listing. TypeScript tracks the expected result of each call.

The helper ultimately uses `return result as T`. Here, `as T` asks TypeScript to trust the programmer's assertion. It does not inspect fields, convert malformed data into a valid object, or validate the server response. This distinction matters when reading the apparently reassuring `<Snapshot>`.

**9. Promises describe work that finishes later.** Network requests take time. A promise represents an eventual value or failure. An `async` function returns a promise. Inside it, `await` pauses that function's continuation until the awaited operation settles; the browser can keep processing other work. See [MDN's async function reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function).

In [api.ts](../src/client/api.ts#L13), `await fetch(...)` waits for the HTTP response. A second `await response.json()` waits for its body to be read and parsed. If an awaited promise rejects, a surrounding `try`/`catch` can handle the failure. A `finally` block runs afterward whether the operation succeeded or failed, making it useful for resetting a busy flag.

Declaring an async function does not start a request. Calling it does.

**10. Components describe the visible interface.** [main.tsx](../src/client/main.tsx#L6) connects React to the HTML element named `root` and renders `<App />`. [App.tsx](../src/client/App.tsx#L12) exports the `App` function.

The HTML-like syntax in `.tsx` files is JSX. For example, `<p>{error}</p>` describes a paragraph containing the current `error` value. Braces inside JSX let JavaScript expressions supply values. `className` selects CSS classes; `onClick` supplies an event callback.

A render means React calls component functions to calculate the desired interface. React then applies the necessary updates. It does not mean a full browser reload. Functions called during a render should not casually start requests or timers; the hook's effect handles that work.

**11. State remembers values between renders.** This actual line from [App.tsx](../src/client/App.tsx#L15) combines the earlier concepts:

```ts
const [screen, setScreen] = useState<Screen>('inventory');
```

`useState` is a React hook, a function for using a React capability inside a component or another hook. `'inventory'` is the initial value. `screen` is the value for the current render; `setScreen` requests an update for a later render. Calling the setter does not rewrite the current render's local variable. React preserves the stored value when it calls the component again. See [React's useState reference](https://react.dev/reference/react/useState).

Here, `selectScreen` calls `setScreen` in [App.tsx](../src/client/App.tsx#L46). The containers near [line 173](../src/client/App.tsx#L173) use `hidden={screen !== 'inventory'}` and similar expressions. Most navigation hides a screen while keeping its component mounted. Rendering and mounting are different: mounting introduces a component into the UI; rendering can happen many times afterward.

**12. `useWorkspace` is this project's custom hook.** [App.tsx](../src/client/App.tsx#L13) calls it and receives an object containing data and action functions. The hook owns the server snapshot and shared busy/error/success messages; `App` keeps navigation choices separately.

In [useWorkspace.ts](../src/client/useWorkspace.ts#L12):

```ts
const [state, setState] = useState<Snapshot | null>(null);
const [busy, setBusy] = useState('');
const [error, setError] = useState('');
const [notice, setNotice] = useState('');
```

`state` initially contains `null`, so [App's startup branch](../src/client/App.tsx#L18) displays an opening message. The other values initially contain empty strings. After a snapshot arrives, `setState(next)` requests a render with that data.

The `use` naming convention identifies custom hooks. They share reusable logic; separate calls normally have separate stored state. This app calls the hook in `App` and passes its returned object to screens. See [React's custom hook guide](https://react.dev/learn/reusing-logic-with-custom-hooks).

**13. Refs remember bookkeeping without requesting renders.** [useWorkspace.ts](../src/client/useWorkspace.ts#L16) creates three refs: `mounted`, `actionInFlight`, and `snapshotGeneration`. A ref is an object with a mutable `.current` property that persists across renders.

`mounted.current` tracks whether updates still belong to a mounted hook. `actionInFlight.current` tracks a running command. `snapshotGeneration.current` is a sequence number used to reject an older observation. Changing these properties does not itself ask React to redraw. Visible messages use state because their changes should appear in the interface.

**14. The effect starts observation and cleans it up.** The [effect](../src/client/useWorkspace.ts#L20) runs its setup after React commits the mounted UI. It creates an `AbortController`, defines `loadSnapshot`, calls it immediately, and starts an interval that attempts another load every `15_000` milliseconds, or 15 seconds. The underscore makes the number easier to read.

`void loadSnapshot()` calls the function and discards its returned promise value. It does not cancel or await it. This function handles its request errors internally.

The final `[]` is the effect's dependency list. These state updates do not cause its setup to rerun. Its returned cleanup function marks it unmounted, signals cancellation, and clears the timer. This project enables `StrictMode` in [main.tsx](../src/client/main.tsx#L7), so React also exercises an extra setup/cleanup cycle during development. “Exactly once forever” would be misleading. See [React's useEffect reference](https://react.dev/reference/react/useEffect).

**15. Read the exact request one piece at a time.** [useWorkspace.ts](../src/client/useWorkspace.ts#L30) contains:

```ts
const next = await requestJson<Snapshot>('/state', undefined, abort.signal);
```

`requestJson` is the imported helper. `<Snapshot>` supplies the expected result type. `'/state'` is argument one, the path. `undefined` occupies argument two, supplying no body while allowing argument three, `abort.signal`, to be passed. That signal lets cleanup cancel this effect's fetch operations.

The helper adds `/api` to the path, producing `/api/state`. With no body it supplies no HTTP method, so `fetch` uses GET. With a body it explicitly uses POST and serializes that body. It parses JSON, checks `response.ok`, throws an error for an unsuccessful HTTP status, and otherwise returns the asserted result type. These branches are in [api.ts](../src/client/api.ts#L13).

On success, `next` receives the parsed value. The hook then checks cancellation and the generation number before storing it. A failure goes into `catch`, which can update the visible error.

The poll reads the application's current snapshot. Its 15-second interval does not itself mean “read fresh stock from Tally every 15 seconds.” Backend refresh scheduling is separate.

**16. The guards prevent conflicting updates.** In [loadSnapshot](../src/client/useWorkspace.ts#L25), `pollInFlight` prevents overlapping polling requests. It is an ordinary variable retained by this effect's callbacks. `actionInFlight.current` skips polling during a command.

Each observation captures a generation number. Starting a command increases that number, so an earlier, slower observation cannot overwrite the newer command result. This is why the condition before `setState(next)` matters.

Cleanup cancels this effect's requests. The command helpers do not receive that abort signal; their `mounted.current` checks suppress later UI updates rather than cancelling all server work.

**17. Command helpers wrap operations and feedback.** [runAction](../src/client/useWorkspace.ts#L50) receives a label, an operation callback, and success text or a function that produces that text. It prevents overlapping actions, sets busy feedback, clears old messages, awaits the operation, and returns success or failure information.

`operation: () => Promise<T>` means “a function taking no arguments that returns a promise of `T`.” [ActionResult](../src/client/api.ts#L2) is either `{ ok: true, value: T }` or `{ ok: false, error: string }`. Callers must inspect `ok`; a caught failure can be returned normally.

`useCallback` keeps a function reference stable while its listed dependencies stay unchanged. It neither runs the function nor caches its server response. `mutate`, `prepareReview`, `publishReview`, `refreshTally`, and `backUpNow` supply particular operations to `runAction`.

The hook's [returned object](../src/client/useWorkspace.ts#L145) exposes these functions and current values. `{ state }` means `{ state: state }`. `ReturnType<typeof useWorkspace>` names the type of that returned object without executing the hook.

**18. Configuration works because a tool reads it.** The build script in [package.json](../package.json#L11) is exactly:

```text
tsc -p tsconfig.json && vite build
```

When `npm run build` runs this script, `tsc` is the TypeScript compiler; `-p tsconfig.json` explicitly selects its project configuration. `&&` runs `vite build` only if compilation succeeds. [tsconfig.json](../tsconfig.json#L2) configures checking, JSX, modules, included source files, and output to `dist`.

Without `-p` or input filenames, `tsc` can discover a `tsconfig.json` by searching upward. Supplying input filenames instead changes that behavior and ignores the project configuration. Our script avoids that ambiguity with `-p`. See [TypeScript's configuration reference](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html).

Vite automatically looks for its root configuration, including the supported `vite.config.ts` filename. An explicit `--config` can select another file, but this script does not use it. Our [Vite configuration](../vite.config.ts#L3) enables React support, writes browser output to `dist/web`, and forwards development `/api` requests to the backend on port 4311. See [Vite configuration](https://vite.dev/config/).

Vite can use relevant TypeScript settings, but transforming TypeScript for the browser is not full type checking. That is why the separate `tsc` step matters. Merely creating either configuration file runs nothing; an invoked tool must read it. Follow [CONTRIBUTING](../CONTRIBUTING.md#build-and-reload-behavior) for actual build and restart instructions.

**19. Global CSS reaches the UI through an import.** [main.tsx](../src/client/main.tsx#L4) imports `./styles.css`. Vite processes that import: development serves the styles with updates, and production builds package CSS assets. Its TypeScript transformation and CSS handling are described in [Vite features](https://vite.dev/guide/features.html).

This is an ordinary global stylesheet. [styles.css](../src/client/styles.css#L3) defines `:root` defaults, `body` rules, and `button` rules. Such selectors apply to matching elements throughout the page. A class selector such as `.main-content` applies wherever JSX uses `className="main-content"`. React does not isolate ordinary CSS by component file.

The stylesheet has an effect because the entry module imports it and the browser loads the resulting styles. Its presence in the folder alone would not apply it. With these foundations, continue to the [request walkthrough](request-walkthrough.md) to follow one real request through the remaining layers.
