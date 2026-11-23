import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { error, log } from 'node:console';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';

const execute = promisify(execFile);
const { fetch, AbortSignal } = globalThis;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secrets = new Set();

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function redacted(value) {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '<REDACTED>');
  return text;
}

function containedPath(directory, file) {
  assert.equal(typeof file, 'string', 'Manifest paths must be strings.');
  assert.ok(
    file && !file.includes('\\') && posix.normalize(file) === file,
    'Invalid package path.',
  );
  const path = resolve(directory, file);
  assert.ok(
    path.startsWith(resolve(directory) + sep),
    'Package path must remain inside its folder.',
  );
  return path;
}

function readRuntimeRecord(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof record.token === 'string') secrets.add(record.token);
  return {
    instanceId: record.instanceId,
    pid: record.pid,
    version: record.version,
    url: record.url,
  };
}

async function availablePort(port) {
  const probe = createPortProbe();
  await new Promise((accept, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', accept);
  });
  const selected = probe.address().port;
  await new Promise((accept, reject) =>
    probe.close((failure) => (failure ? reject(failure) : accept())),
  );
  return selected;
}

async function command(program, args, options = {}, allowFailure = false) {
  try {
    const result = await execute(program, args, {
      windowsHide: true,
      timeout: 45_000,
      maxBuffer: 2_000_000,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (failure) {
    if (allowFailure && typeof failure.code === 'number') {
      return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
    throw new Error(
      `Command failed: ${basename(program)} ${args[0] ?? ''}. ${redacted(failure.stderr || failure.message)}`,
      { cause: failure },
    );
  }
}

function jsonPrefix(output) {
  const text = output.trimStart();
  assert.equal(text[0], '{', 'The restore CLI must begin with its JSON result.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return JSON.parse(text.slice(0, index + 1));
  }
  throw new Error('The restore CLI returned incomplete JSON.');
}

function runtimeEnvironment(system32, dataDirectory) {
  const excluded = new Set([
    'PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_USE_ENV_PROXY',
    'STOCKBRIDGE_DATA_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !excluded.has(key.toUpperCase())),
  );
  return {
    ...environment,
    PATH: system32,
    STOCKBRIDGE_DATA_DIR: dataDirectory,
    NO_PROXY: '127.0.0.1,localhost',
  };
}

async function tallyFixture() {
  const companyId = 'package-verification-company';
  const itemId = 'package-verification-item';
  const failures = [];
  let requests = 0;
  let quantity = 4;
  const envelope = (content) =>
    `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${content}</COLLECTION></DATA></BODY></ENVELOPE>`;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.match(request.headers['content-type'] ?? '', /^text\/xml/);
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 100_000, 'Unexpectedly large Tally request.');
      }
      assert.match(body, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
      assert.doesNotMatch(body, /<TALLYREQUEST>(Import|Execute)<\/TALLYREQUEST>/);
      requests++;
      const content = body.includes('<TYPE>StockItem</TYPE>')
        ? `<STOCKITEM NAME="Package verification tyre"><GUID>${itemId}</GUID><BASEUNITS>nos</BASEUNITS><CLOSINGBALANCE>${quantity} nos</CLOSINGBALANCE><STOCKBRIDGECOMPANYGUID>${companyId}</STOCKBRIDGECOMPANYGUID></STOCKITEM>`
        : `<COMPANY><NAME>Package verification company</NAME><GUID>${companyId}</GUID></COMPANY>`;
      response.writeHead(200, { 'Content-Type': 'text/xml' });
      response.end(envelope(content));
    } catch (failure) {
      failures.push(failure.message);
      response.writeHead(500);
      response.end('Invalid package-verification request.');
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    companyId: `tally:${companyId}`,
    itemId: `tally:${companyId}:${itemId}`,
    setQuantity(value) {
      quantity = value;
    },
    evidence() {
      return { requests, failures };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((accept, reject) =>
        server.close((failure) => (failure ? reject(failure) : accept())),
      );
    },
  };
}

async function requestApi(dashboard, path, body, expectedStatus = 200, timeoutMs = 5000) {
  const response = await fetch(dashboard + path, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
          body: JSON.stringify(body),
        }),
  });
  assert.equal(response.status, expectedStatus, `${path} returned an unexpected HTTP status.`);
  return response.json();
}

async function verifyPilot(zip) {
  assert.equal(process.platform, 'win32', 'Run the portable Windows package check on Windows.');
  assert.ok(
    zip && isAbsolute(zip) && zip.endsWith('.zip'),
    'Usage: node scripts/verify-pilot.mjs <absolute ZIP path>',
  );
  assert.ok(existsSync(zip), 'The supplied ZIP does not exist.');
  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true });
  assert.ok(!lstatSync(releases).isSymbolicLink(), 'The releases folder must not be a link.');
  const verification = mkdtempSync(join(releases, 'verify-pilot-'));
  const receipt = join(verification, 'verification.json');
  const evidence = {
    startedAt: new Date().toISOString(),
    zip,
    verification,
    status: 'running',
    checks: [],
  };
  let fixture;
  let node;
  let launcher;
  let options;
  let runtimeFile;
  async function check(name, run) {
    const started = Date.now();
    try {
      const details = await run();
      evidence.checks.push({ name, passed: true, durationMs: Date.now() - started, ...details });
      return details;
    } catch (failure) {
      evidence.checks.push({
        name,
        passed: false,
        durationMs: Date.now() - started,
        error: redacted(failure.message),
      });
      throw failure;
    }
  }
  try {
    await check('zip_sha256', async () => {
      const sidecar = readFileSync(`${zip}.sha256`, 'utf8')
        .trim()
        .match(/^([a-f\d]{64})\s+\*?(.+)$/i);
      assert.ok(sidecar, 'The ZIP needs its SHA256 sidecar.');
      assert.equal(sidecar[2], basename(zip));
      const digest = sha256(zip);
      assert.equal(digest, sidecar[1].toLowerCase(), 'ZIP checksum mismatch.');
      return { sha256: digest, bytes: statSync(zip).size };
    });
    const extracted = join(verification, 'extracted');
    mkdirSync(extracted);
    const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    await check('safe_zip_extraction', async () => {
      await command(
        join(system32, 'WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            "$ErrorActionPreference = 'Stop'",
            'Add-Type -AssemblyName System.IO.Compression.FileSystem',
            '$destination = [System.IO.Path]::GetFullPath($env:STOCKBRIDGE_VERIFY_EXTRACT) + [System.IO.Path]::DirectorySeparatorChar',
            '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:STOCKBRIDGE_VERIFY_ZIP)',
            'try { foreach ($entry in $archive.Entries) {',
            '  $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destination, $entry.FullName))',
            "  if (-not $target.StartsWith($destination, [System.StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe ZIP entry.' }",
            '} } finally { $archive.Dispose() }',
            '[System.IO.Compression.ZipFile]::ExtractToDirectory($env:STOCKBRIDGE_VERIFY_ZIP, $env:STOCKBRIDGE_VERIFY_EXTRACT)',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            STOCKBRIDGE_VERIFY_ZIP: zip,
            STOCKBRIDGE_VERIFY_EXTRACT: extracted,
          },
        },
      );
      const roots = readdirSync(extracted);
      assert.equal(roots.length, 1, 'The ZIP must have one package root.');
      assert.ok(statSync(join(extracted, roots[0])).isDirectory());
    });
    const packageRoot = join(extracted, readdirSync(extracted)[0]);
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8'));
    evidence.package = {
      version: manifest.version,
      commit: manifest.commit,
      dirty: manifest.dirty,
      root: packageRoot,
    };
    await check('manifest_files_and_runtime_only_contents', async () => {
      assert.equal(manifest.formatVersion, 1);
      const files = readdirSync(packageRoot, { recursive: true })
        .filter((file) => {
          assert.ok(
            !lstatSync(join(packageRoot, file)).isSymbolicLink(),
            'Package files cannot be links.',
          );
          return statSync(join(packageRoot, file)).isFile();
        })
        .map((file) => file.replaceAll('\\', '/'))
        .sort();
      assert.deepEqual(
        files,
        [...manifest.files.map((file) => file.path), 'manifest.json'].sort(),
        'Every package file must appear exactly once in the manifest.',
      );
      const dependencyPaths = new Set();
      for (const file of manifest.files) {
        const path = containedPath(packageRoot, file.path);
        const parts = file.path.split('/');
        assert.ok(
          !parts.some(
            (part) =>
              ['.data', '.git', '.cache', '.tools'].includes(part) || part.startsWith('.env'),
          ),
          `Private/runtime input included: ${file.path}`,
        );
        assert.ok(
          !/\.(?:sqlite(?:-wal|-shm|-journal)?|db|runtime\.json|diagnostics\.ndjson|log|credentials(?:\.[^.]+\.tmp)?)$/i.test(
            file.path,
          ),
          `Runtime records included: ${file.path}`,
        );
        assert.ok(
          !/^(?:tests\/|dist\/tests\/)/.test(file.path),
          'Test output must not be packaged.',
        );
        assert.ok(
          !['scripts/verify-pilot.mjs', 'scripts/package-pilot.mjs'].includes(file.path),
          'Build/test tools must not be packaged.',
        );
        const moduleIndex = parts.lastIndexOf('node_modules');
        if (moduleIndex >= 0)
          dependencyPaths.add(
            parts
              .slice(0, moduleIndex + (parts[moduleIndex + 1]?.startsWith('@') ? 3 : 2))
              .join('/'),
          );
        assert.equal(statSync(path).size, file.bytes, `Wrong file size: ${file.path}`);
        assert.equal(sha256(path), file.sha256, `Checksum mismatch: ${file.path}`);
      }
      const lock = JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'));
      const expectedDependencies = Object.entries(lock.packages)
        .filter(([path, value]) => path && !value.dev)
        .map(([path]) => path)
        .sort();
      assert.deepEqual([...dependencyPaths].sort(), expectedDependencies);
      assert.deepEqual(
        manifest.dependencies.map((dependency) => dependency.path).sort(),
        expectedDependencies,
      );
      for (const dependency of manifest.dependencies) {
        const installed = JSON.parse(
          readFileSync(join(packageRoot, dependency.path, 'package.json'), 'utf8'),
        );
        assert.equal(installed.version, dependency.version);
        assert.equal(installed.version, lock.packages[dependency.path].version);
      }
      assert.ok(!existsSync(join(packageRoot, 'runtime/node_modules')));
      return { files: files.length, productionDependencies: dependencyPaths.size };
    });
    await check('customer_guide_and_live_publication_notice', async () => {
      assert.match(manifest.purpose, /live stock or prices/i);
      assert.match(manifest.purpose, /live stock automatically/i);
      const expectedRoot = [
        'dist',
        'node_modules',
        'runtime',
        'scripts',
        'package.json',
        'package-lock.json',
        'manifest.json',
        'Read Me.html',
        'Start Stockbridge.cmd',
        ...(existsSync(join(packageRoot, 'Upgrade Stockbridge.cmd'))
          ? ['Upgrade Stockbridge.cmd']
          : []),
        'Stop Stockbridge.cmd',
        'Stockbridge Status.cmd',
        'Open Data Folder.cmd',
      ];
      assert.deepEqual(
        readdirSync(packageRoot).sort(),
        expectedRoot.sort(),
        'Only runtime files and the customer guide belong in the ZIP.',
      );
      for (const { path } of manifest.files) {
        assert.doesNotMatch(
          path,
          /(?:^|\/)(?:marketplace-credentials|backups)(?:\/|$)|\.(?:sqlite|db|ndjson|xlsx|csv|pem|pfx)$/i,
        );
      }
      const guide = new JSDOM(readFileSync(join(packageRoot, 'Read Me.html'), 'utf8')).window
        .document;
      assert.match(guide.querySelector('h1')?.textContent ?? '', /Stockbridge/i);
      if (guide.body.textContent.includes('Upgrade Stockbridge.cmd'))
        assert.match(
          readFileSync(join(packageRoot, 'Upgrade Stockbridge.cmd'), 'utf8'),
          /windows-launcher\.mjs" upgrade/,
        );
      assert.match(guide.body.textContent, /approved actions can change stock or prices/i);
      assert.doesNotMatch(
        guide.body.textContent,
        /HingadTyre|marketplace publication is unavailable/i,
      );
      assert.doesNotMatch(
        guide.body.textContent,
        /\uFFFD/u,
        'The customer guide has an invalid character.',
      );
      const links = [...guide.querySelectorAll('a[href]')];
      assert.ok(links.length > 0, 'The guide should link to its sections and public help.');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href.startsWith('#')) {
          assert.ok(
            guide.getElementById(decodeURIComponent(href.slice(1))),
            `Missing guide section: ${href}`,
          );
        } else {
          const url = new globalThis.URL(href);
          assert.ok(
            (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
              (url.protocol === 'https:' &&
                ['help.tallysolutions.com', 'seller.flipkart.com'].includes(url.hostname)),
            `Unexpected customer guide link: ${href}`,
          );
        }
      }
      for (const image of guide.querySelectorAll('img[src]')) {
        const source = decodeURIComponent(image.getAttribute('src'));
        assert.ok(existsSync(containedPath(packageRoot, source)), `Missing guide image: ${source}`);
      }
      return { guideLinks: links.length };
    });
    node = join(packageRoot, 'runtime/node.exe');
    launcher = join(packageRoot, 'scripts/windows-launcher.mjs');
    const restore = join(packageRoot, 'scripts/restore-pilot.mjs');
    const workingDirectory = join(verification, 'unrelated working folder');
    const dataDirectory = join(verification, 'isolated data');
    mkdirSync(workingDirectory);
    mkdirSync(dataDirectory);
    // Earlier packages only accept the default live dashboard port.
    const configurablePort = existsSync(join(packageRoot, 'dist/src/shared/dashboard-port.js'));
    const { port } = await check('dashboard_port_is_free', async () => ({
      port: await availablePort(configurablePort ? 0 : 4310),
    }));
    const dashboard = `http://127.0.0.1:${port}`;
    const api = requestApi.bind(null, dashboard);
    options = { cwd: workingDirectory, env: runtimeEnvironment(system32, dataDirectory) };
    options.env.STOCKBRIDGE_DASHBOARD_PORT = String(port);
    const desktop = join(verification, 'isolated desktop');
    mkdirSync(desktop);
    options.env.STOCKBRIDGE_DESKTOP_DIR = desktop;
    const managedShortcut = existsSync(join(packageRoot, 'dist/src/desktop/shortcut.js'));
    runtimeFile = join(dataDirectory, 'live.runtime.json');
    const launch = (action) => command(node, [launcher, action, '--no-browser'], options);
    const hasUpgrade = existsSync(join(packageRoot, 'Upgrade Stockbridge.cmd'));
    if (hasUpgrade)
      await check('upgrade_requires_existing_workspace', async () => {
        const result = await command(node, [launcher, 'upgrade', '--no-browser'], options, true);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /No existing Stockbridge workspace/);
        assert.ok(!existsSync(join(dataDirectory, 'live.sqlite')));
      });
    await check('bundled_node_without_development_toolchain', async () => {
      for (const tool of ['node', 'npm']) {
        const found = await command(join(system32, 'where.exe'), [tool], options, true);
        assert.notEqual(
          found.code,
          0,
          `${tool} must not be available through the smoke-test PATH.`,
        );
      }
      const runtime = JSON.parse(
        (
          await command(
            node,
            [
              '-p',
              'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})',
            ],
            options,
          )
        ).stdout,
      );
      assert.deepEqual(runtime, manifest.runtime);
      assert.match(runtime.version, /^v24\./);
      assert.equal(runtime.platform, 'win32');
      assert.equal(runtime.arch, 'x64');
      return { runtime, workingDirectory, pathContainsNodeOrNpm: false };
    });
    fixture = await tallyFixture();
    await check('empty_live_workspace_uses_only_the_local_fixture', async () => {
      const preparation = `
        import { pathToFileURL } from 'node:url';
        import { join } from 'node:path';
        const { Store } = await import(pathToFileURL(process.env.STOCKBRIDGE_VERIFY_STORE).href);
        const store = new Store(join(process.env.STOCKBRIDGE_DATA_DIR, 'live.sqlite'), 'live');
        try { store.update((state) => { state.settings.tallyUrl = process.env.STOCKBRIDGE_VERIFY_TALLY; }); }
        finally { store.close(); }
      `;
      await command(node, ['--input-type=module', '-e', preparation], {
        ...options,
        env: {
          ...options.env,
          STOCKBRIDGE_VERIFY_STORE: join(packageRoot, 'dist/src/server/store.js'),
          STOCKBRIDGE_VERIFY_TALLY: fixture.url,
        },
      });
      await launch('start');
      const health = await api('/api/health');
      assert.equal(health.application, 'stockbridge');
      assert.equal(health.version, manifest.version);
      assert.equal(health.mode, 'live');
      assert.equal(health.publishingEnabled, true);
      assert.ok(!Object.hasOwn(health, 'token'), 'Health must not expose the runtime token.');
      const record = readRuntimeRecord(runtimeFile);
      assert.equal(record.instanceId, health.instanceId);
      assert.equal(record.url, dashboard);
      const state = await api('/api/state');
      assert.equal(state.mode, 'live');
      assert.equal(state.publishingEnabled, true);
      assert.deepEqual(state.companies, []);
      assert.deepEqual(state.items, []);
      assert.deepEqual(state.listings, []);
      assert.deepEqual(state.proposals, []);
      assert.deepEqual(state.accounts, []);
      assert.equal(state.settings.tallyUrl, fixture.url);
      assert.ok(!existsSync(join(packageRoot, '.data')));
      return {
        health,
        sellerAccounts: state.accounts.length,
        dataDirectory,
        tallyEndpoint: fixture.url,
      };
    });
    const firstInstance = readRuntimeRecord(runtimeFile);
    await check('local_flipkart_setup_has_no_saved_credentials', async () => {
      const status = await api('/api/flipkart/connection');
      assert.equal(status.state, 'not-configured');
      assert.equal(status.applicationIdHint, null);
      assert.equal(status.expiresAt, null);
      const checked = await api('/api/flipkart/check', {}, 409);
      assert.match(checked.error, /Connect a seller-owned Flipkart application first/);
      assert.ok(!existsSync(join(dataDirectory, 'flipkart-self-access.credentials')));
      assert.equal((await api('/api/state')).publishingEnabled, true);
      return { credentialsPresent: false, publishingEnabled: true };
    });
    let marketplaceAccounts;
    await check('marketplace_accounts_are_explicit_and_credentials_are_separate', async () => {
      assert.deepEqual(await api('/api/marketplaces'), { accounts: [] });
      marketplaceAccounts = [];
      for (const suffix of ['0001', '0002']) {
        const applicationSecret = `package-fixture-secret-${suffix}`;
        secrets.add(applicationSecret);
        // Save and status each invoke bounded Windows credential protection.
        const account = await api(
          '/api/marketplaces/add',
          {
            marketplace: 'flipkart',
            name: `Package seller ${suffix}`,
            applicationId: `package-fixture-${suffix}`,
            applicationSecret,
            verify: false,
          },
          200,
          30_000,
        );
        assert.equal(account.sellerId, null);
        assert.equal(account.lastRefreshedAt, null);
        assert.equal(account.connection.applicationIdHint, `***${suffix}`);
        assert.equal(account.connection.expiresAt, null);
        assert.equal(JSON.stringify(account).includes(applicationSecret), false);
        const credentials = join(
          dataDirectory,
          'marketplace-credentials',
          account.id,
          'flipkart-self-access.credentials',
        );
        assert.ok(existsSync(credentials));
        assert.equal(readFileSync(credentials, 'utf8').includes(applicationSecret), false);
        const page = await api(`/api/marketplaces/listings?accountId=${account.id}`);
        assert.equal(page.total, 0);
        assert.deepEqual(page.listings, []);
        marketplaceAccounts.push(account);
      }
      assert.notEqual(marketplaceAccounts[0].id, marketplaceAccounts[1].id);
      await api('/api/marketplaces/connection', {
        accountId: marketplaceAccounts[0].id,
        action: 'disconnect',
      });
      const directory = (await api('/api/marketplaces', undefined, 200, 30_000)).accounts;
      assert.equal(directory.length, 2);
      assert.equal(directory[0].connection.applicationIdHint, null);
      assert.equal(directory[1].connection.applicationIdHint, '***0002');
      assert.equal((await api('/api/state')).publishingEnabled, true);
      return { accounts: 2, separateProtectedFiles: true, verifyRequested: false };
    });
    await check('dashboard_and_compiled_assets', async () => {
      const response = await fetch(dashboard, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.equal(html, readFileSync(join(packageRoot, 'dist/web/index.html'), 'utf8'));
      const assets = [
        ...new Set(
          [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]),
        ),
      ];
      assert.ok(assets.some((path) => path.endsWith('.js')));
      assert.ok(assets.some((path) => path.endsWith('.css')));
      for (const path of assets) {
        const asset = await fetch(dashboard + path, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        assert.equal(asset.status, 200);
        const bytes = Buffer.from(await asset.arrayBuffer());
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          sha256(containedPath(join(packageRoot, 'dist/web'), path.slice(1))),
        );
      }
      return { assets };
    });
    await check('repeat_start_keeps_the_same_instance', async () => {
      await launch('start');
      assert.deepEqual(readRuntimeRecord(runtimeFile), firstInstance);
      assert.equal((await api('/api/health')).instanceId, firstInstance.instanceId);
      const status = await launch('status');
      assert.match(status.stdout, /is running/);
      return { instanceId: firstInstance.instanceId, pid: firstInstance.pid };
    });
    let state;
    await check('read_only_tally_fixture_import', async () => {
      state = await api('/api/refresh', {});
      assert.equal(state.connection.tally, 'online');
      assert.equal(state.companies.length, 1);
      assert.equal(state.companies[0].id, fixture.companyId);
      assert.equal(state.items.length, 1);
      assert.equal(state.items[0].id, fixture.itemId);
      assert.equal(state.items[0].physical, 4);
      assert.equal(state.items[0].unit, 'nos');
      assert.equal(state.publishingEnabled, true);
      assert.ok(fixture.evidence().requests >= 3);
      assert.deepEqual(fixture.evidence().failures, []);
      return { companyId: fixture.companyId, itemId: fixture.itemId, physical: 4 };
    });
    let backup;
    let backupDigest;
    await check('settings_and_verified_backup', async () => {
      const settings = {
        ...state.settings,
        tallySeconds: 45,
        backupFolder: join(dataDirectory, 'verified backups'),
      };
      state = await api('/api/settings', { settings });
      assert.deepEqual(state.settings, settings);
      backup = await api('/api/backup', {});
      assert.equal(backup.verified, true);
      assert.ok(backup.path.startsWith(settings.backupFolder + sep));
      const backupManifest = JSON.parse(readFileSync(`${backup.path}.json`, 'utf8'));
      assert.equal(backupManifest.verified, true);
      assert.equal(backupManifest.mode, 'live');
      backupDigest = sha256(backup.path);
      return { tallySeconds: 45, backupPath: backup.path, backupSha256: backupDigest };
    });
    await check('runtime_stop_and_publishing_are_protected', async () => {
      const rejected = await api('/api/runtime/stop', {}, 403);
      assert.match(rejected.error, /authorization/);
      assert.equal((await api('/api/health')).instanceId, firstInstance.instanceId);
      const publish = await api('/api/publish', {}, 409);
      assert.match(publish.error, /fresh Inventory review/);
      return { stopWithoutToken: 403, publishing: 409 };
    });
    const restoreArguments = [
      'restore',
      '--backup',
      backup.path,
      '--mode',
      'live',
      '--data-dir',
      dataDirectory,
      '--expected-sha256',
      backupDigest,
      '--confirm-replace',
    ];
    await check('restore_refuses_a_running_workspace', async () => {
      const rejected = await command(node, [restore, ...restoreArguments], options, true);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /already running/);
      assert.equal((await api('/api/health')).instanceId, firstInstance.instanceId);
      assert.equal((await api('/api/state')).items[0].physical, 4);
      return { exitCode: rejected.code, originalInstanceRetained: true };
    });
    await check('stop_completes_before_offline_restore', async () => {
      fixture.setQuantity(9);
      assert.equal((await api('/api/refresh', {})).items[0].physical, 9);
      const stopped = await launch('stop');
      assert.match(stopped.stdout, /stopped/);
      assert.ok(
        !existsSync(runtimeFile),
        'Stop must remove its runtime record before reporting completion.',
      );
      await availablePort(port);
      return { runtimeRecordRemoved: true, physicalBeforeRestore: 9 };
    });
    await check('inspect_and_digest_confirmed_offline_restore', async () => {
      const inspected = jsonPrefix(
        (
          await command(
            node,
            [restore, 'inspect', '--backup', backup.path, '--mode', 'live'],
            options,
          )
        ).stdout,
      );
      assert.equal(inspected.sha256, backupDigest);
      assert.equal(inspected.counts.companies, 1);
      assert.equal(inspected.counts.stockItems, 1);
      assert.equal(inspected.mode, 'live');
      assert.equal(inspected.publishingEnabled, false);
      const restored = jsonPrefix(
        (await command(node, [restore, ...restoreArguments], options)).stdout,
      );
      assert.equal(restored.restored, true);
      assert.equal(restored.publishingEnabled, false);
      assert.equal(restored.requiresFreshRead, true);
      assert.ok(restored.safetyBackup.startsWith(dataDirectory + sep));
      assert.ok(existsSync(restored.safetyBackup));
      assert.ok(existsSync(`${restored.safetyBackup}.json`));
      assert.equal(
        sha256(backup.path),
        backupDigest,
        'Restore must not alter the selected backup.',
      );
      return {
        backupSha256: inspected.sha256,
        counts: inspected.counts,
        safetyBackup: restored.safetyBackup,
        requiresFreshRead: true,
      };
    });
    await check('restart_preserves_settings_and_restored_stock', async () => {
      await launch('start');
      const health = await api('/api/health');
      assert.notEqual(health.instanceId, firstInstance.instanceId);
      readRuntimeRecord(runtimeFile);
      const restored = await api('/api/state');
      assert.equal(restored.settings.tallySeconds, 45);
      assert.equal(restored.settings.tallyUrl, fixture.url);
      assert.equal(restored.settings.backupFolder, join(dataDirectory, 'verified backups'));
      assert.equal(restored.items[0].physical, 4);
      assert.equal(restored.items[0].id, fixture.itemId);
      assert.equal(restored.items[0].observedAt, null);
      assert.equal(restored.companies[0].automation, false);
      assert.equal(restored.connection.tally, 'not-checked');
      assert.equal(restored.publishingEnabled, true);
      assert.ok(restored.activity.some((entry) => entry.operation === 'pilot-restore'));
      assert.ok(!existsSync(join(packageRoot, '.data')));
      const accounts = (await api('/api/marketplaces', undefined, 200, 30_000)).accounts;
      assert.deepEqual(
        accounts.map((account) => ({ id: account.id, name: account.name })),
        marketplaceAccounts.map((account) => ({ id: account.id, name: account.name })),
      );
      assert.equal(accounts[0].connection.applicationIdHint, null);
      assert.equal(accounts[1].connection.applicationIdHint, '***0002');
      assert.ok(accounts.every((account) => account.lastRefreshedAt === null));
      return {
        instanceId: health.instanceId,
        tallySeconds: 45,
        restoredPhysical: 4,
        publishingEnabled: true,
      };
    });
    if (hasUpgrade) {
      const initialItem = (await api('/api/state')).items[0];
      const hasKeepBack = Object.hasOwn(initialItem, 'keepBackUnits');
      await check('upgrade_restarts_running_workspace_with_saved_data', async () => {
        const previous = readRuntimeRecord(runtimeFile);
        if (hasKeepBack)
          await api('/api/items/keep-back', {
            companyId: initialItem.companyId,
            itemId: initialItem.id,
            itemVersion: initialItem.version,
            keepBackUnits: 1.25,
          });
        const result = await launch('upgrade');
        assert.match(result.stdout, /Verified safety copy:/);
        assert.notEqual(readRuntimeRecord(runtimeFile).instanceId, previous.instanceId);
        const item = (await api('/api/state')).items[0];
        assert.equal(item.id, fixture.itemId);
        if (hasKeepBack) assert.equal(item.keepBackUnits, 1.25);
      });
      await check('upgrade_migrates_existing_schema_ten_and_keeps_credentials', async () => {
        await launch('stop');
        // Recreate the previous format on the isolated, populated test database.
        const preparePrevious = `
          import { DatabaseSync } from 'node:sqlite';
          import { join } from 'node:path';
          const db = new DatabaseSync(join(process.env.STOCKBRIDGE_DATA_DIR, 'live.sqlite'));
          db.exec('UPDATE companies SET automation = 1');
          db.prepare("INSERT INTO listings (id,account_id,sku,title,location,item_id,pack_size,pack_evidence,verified,policy,remaining,paused,version,sort_order) SELECT 'paused-pilot',?,'pilot-sku','Pilot tyre','test location',id,1,'test fixture',1,'limited',2,1,1,0 FROM stock_items LIMIT 1").run(process.argv[1]);
          if (db.prepare('PRAGMA table_info(stock_items)').all().some(row => row.name === 'keep_back_units')) db.exec('ALTER TABLE stock_items DROP COLUMN keep_back_units');
          db.exec('DROP TABLE sku_mappings; PRAGMA user_version = 10');
          db.close();
        `;
        await command(
          node,
          ['--input-type=module', '-e', preparePrevious, marketplaceAccounts[0].id],
          options,
        );
        const result = await launch('upgrade');
        const path = result.stdout.match(/Verified safety copy: ([^\r\n]+)/)?.[1];
        assert.ok(path && existsSync(path));
        const readVersion =
          "const db = new (require('node:sqlite').DatabaseSync)(process.argv[1], {readOnly:true}); console.log(db.prepare('PRAGMA user_version').get().user_version); db.close();";
        assert.equal((await command(node, ['-e', readVersion, path], options)).stdout.trim(), '10');
        assert.equal(
          (
            await command(node, ['-e', readVersion, join(dataDirectory, 'live.sqlite')], options)
          ).stdout.trim(),
          hasKeepBack ? '12' : '11',
        );
        const state = await api('/api/state');
        assert.equal(state.items[0].id, fixture.itemId);
        if (hasKeepBack) assert.equal(state.items[0].keepBackUnits, 0);
        assert.equal(state.settings.tallySeconds, 45);
        assert.equal(state.companies[0].automation, true);
        const paused = state.listings.find((row) => row.id === 'paused-pilot');
        assert.equal(paused.paused, true);
        assert.equal(paused.policy, 'limited');
        assert.equal(paused.remaining, 2);
        const { accounts } = await api('/api/marketplaces', undefined, 200, 30_000);
        assert.equal(accounts[1].id, marketplaceAccounts[1].id);
        assert.equal(accounts[1].connection.applicationIdHint, '***0002');
      });
    }
    if (managedShortcut) {
      const powershell = join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
      const inspectLink = async (script) =>
        command(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; $path = Join-Path $env:STOCKBRIDGE_DESKTOP_DIR 'Stockbridge.lnk'; $link = (New-Object -ComObject WScript.Shell).CreateShortcut($path); " +
              script,
          ],
          options,
        );
      await check('shortcut_targets_new_package_and_preserves_custom_links', async () => {
        const { stdout } = await inspectLink('$link.TargetPath; $link.Arguments');
        assert.ok(stdout.includes(node));
        assert.ok(stdout.includes(launcher));
        assert.ok(stdout.includes(pathToFileURL(dataDirectory).href));
        assert.ok(stdout.includes('--port ' + port));
        // Follow the shortcut's saved destination in a fresh process without
        // inheriting the upgrade command's workspace or dashboard port.
        const args = stdout
          .trim()
          .split(/\r?\n/)[1]
          .match(/^"([^"]+)" start --workspace "([^"]+)" --port (\d+)$/);
        assert.ok(args);
        await launch('stop');
        const freshEnv = { ...options.env };
        delete freshEnv.STOCKBRIDGE_DATA_DIR;
        delete freshEnv.STOCKBRIDGE_DASHBOARD_PORT;
        await command(
          node,
          [args[1], 'start', '--workspace', args[2], '--port', args[3], '--no-browser'],
          { ...options, env: freshEnv },
        );
        assert.equal((await api('/api/state')).items[0].id, fixture.itemId);
        // Simulate a managed shortcut from a previous package, then a customer-owned one.
        await inspectLink(
          "$link.TargetPath = Join-Path $env:SystemRoot 'explorer.exe'; $link.Save()",
        );
        const updated = await launch('upgrade');
        assert.match(updated.stdout, /desktop shortcut is ready/, updated.stderr || updated.stdout);
        assert.ok((await inspectLink('$link.TargetPath')).stdout.includes(node));
        await inspectLink("$link.Description = 'Customer shortcut'; $link.Save()");
        const customHash = sha256(join(desktop, 'Stockbridge.lnk'));
        assert.match((await launch('upgrade')).stdout, /already in use/);
        assert.equal(sha256(join(desktop, 'Stockbridge.lnk')), customHash);
      });
      await check('dashboard_failure_shows_safety_copy_and_retry_reopens_workspace', async () => {
        await launch('stop');
        const occupied = createPortProbe();
        await new Promise((accept, reject) => {
          occupied.once('error', reject);
          occupied.listen(port, '127.0.0.1', accept);
        });
        let copy;
        let digest;
        try {
          const result = await command(node, [launcher, 'upgrade', '--no-browser'], options, true);
          assert.notEqual(result.code, 0);
          assert.match(result.stderr, /Run Upgrade Stockbridge.cmd again from the new folder/);
          copy = result.stderr.match(/Verified safety copy: ([^\r\n]+)/)?.[1];
          assert.ok(copy && existsSync(copy));
          digest = sha256(copy);
        } finally {
          await new Promise((accept) => occupied.close(accept));
        }
        await launch('upgrade');
        assert.equal(sha256(copy), digest);
        assert.equal(
          (await api('/api/state')).listings.find((row) => row.id === 'paused-pilot').paused,
          true,
        );
      });
    }
    await check('final_stop_and_status', async () => {
      await launch('stop');
      assert.ok(!existsSync(runtimeFile));
      const status = await launch('status');
      assert.match(status.stdout, /Stockbridge is not running\./);
      await availablePort(port);
      assert.deepEqual(fixture.evidence().failures, []);
      return { runtimeRecordRemoved: true, fixture: fixture.evidence() };
    });
    evidence.status = 'passed';
  } catch (failure) {
    evidence.status = 'failed';
    evidence.failure = redacted(failure.message);
    throw new Error(`${redacted(failure.message)} Verification receipt: ${receipt}`, {
      cause: failure,
    });
  } finally {
    try {
      // Only the isolated data folder's authenticated launcher can stop this test instance.
      if (runtimeFile && existsSync(runtimeFile) && node && launcher && options) {
        readRuntimeRecord(runtimeFile);
        await command(node, [launcher, 'stop', '--no-browser'], options);
        assert.ok(
          !existsSync(runtimeFile),
          `The verification instance may still be running. Check the isolated data folder: ${dirname(runtimeFile)}`,
        );
      }
    } catch (failure) {
      evidence.status = 'failed';
      evidence.cleanupFailure = redacted(failure.message);
    } finally {
      await fixture?.close();
      evidence.finishedAt = new Date().toISOString();
      writeFileSync(receipt, redacted(JSON.stringify(evidence, null, 2)) + '\n', { flag: 'wx' });
    }
  }
  assert.equal(evidence.status, 'passed', `Cleanup failed. Read ${receipt}`);
  log(`PASS: ${evidence.checks.length} checks. Receipt: ${receipt}`);
}

try {
  await verifyPilot(process.argv[2]);
} catch (failure) {
  error(redacted(failure instanceof Error ? failure.message : String(failure)));
  process.exitCode = 1;
}
