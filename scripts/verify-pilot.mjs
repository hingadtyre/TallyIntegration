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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const { fetch, AbortSignal } = globalThis;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = 'http://127.0.0.1:4310';
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

async function portAvailable() {
  const probe = createPortProbe();
  await new Promise((accept, reject) => {
    probe.once('error', () =>
      reject(
        new Error(
          'Port 4310 is occupied. Stop the intended app yourself before verification; no existing process was touched.',
        ),
      ),
    );
    probe.listen(4310, '127.0.0.1', accept);
  });
  await new Promise((accept, reject) =>
    probe.close((failure) => (failure ? reject(failure) : accept())),
  );
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

async function api(path, body, expectedStatus = 200) {
  const response = await fetch(dashboard + path, {
    signal: AbortSignal.timeout(5000),
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
    await check('dashboard_port_is_free', async () => {
      await portAvailable();
    });
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
    node = join(packageRoot, 'runtime/node.exe');
    launcher = join(packageRoot, 'scripts/windows-launcher.mjs');
    const restore = join(packageRoot, 'scripts/restore-pilot.mjs');
    const workingDirectory = join(verification, 'unrelated working folder');
    const dataDirectory = join(verification, 'isolated data');
    mkdirSync(workingDirectory);
    mkdirSync(dataDirectory);
    options = { cwd: workingDirectory, env: runtimeEnvironment(system32, dataDirectory) };
    runtimeFile = join(dataDirectory, 'live.runtime.json');
    const launch = (action) => command(node, [launcher, action, '--no-browser'], options);
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
      assert.equal(health.publishingEnabled, false);
      assert.ok(!Object.hasOwn(health, 'token'), 'Health must not expose the runtime token.');
      const record = readRuntimeRecord(runtimeFile);
      assert.equal(record.instanceId, health.instanceId);
      const state = await api('/api/state');
      assert.equal(state.mode, 'live');
      assert.equal(state.publishingEnabled, false);
      assert.deepEqual(state.companies, []);
      assert.deepEqual(state.items, []);
      assert.deepEqual(state.listings, []);
      assert.deepEqual(state.proposals, []);
      assert.equal(state.accounts[0].name, 'Flipkart seller');
      assert.equal(state.accounts[0].status, 'not-connected');
      assert.equal(state.settings.tallyUrl, fixture.url);
      assert.ok(!existsSync(join(packageRoot, '.data')));
      return {
        health,
        neutralAccount: state.accounts[0].name,
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
      assert.equal((await api('/api/state')).publishingEnabled, false);
      return { credentialsPresent: false, publishingEnabled: false };
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
      assert.equal(state.publishingEnabled, false);
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
      assert.match(publish.error, /unavailable/);
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
      await portAvailable();
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
      assert.equal(restored.publishingEnabled, false);
      assert.ok(restored.activity.some((entry) => entry.operation === 'pilot-restore'));
      assert.ok(!existsSync(join(packageRoot, '.data')));
      return {
        instanceId: health.instanceId,
        tallySeconds: 45,
        restoredPhysical: 4,
        publishingEnabled: false,
      };
    });
    await check('final_stop_and_status', async () => {
      await launch('stop');
      assert.ok(!existsSync(runtimeFile));
      const status = await launch('status');
      assert.match(status.stdout, /Stockbridge is not running\./);
      await portAvailable();
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
