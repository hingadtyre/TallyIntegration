import { execFileSync, spawnSync } from 'node:child_process';
import { error, log } from 'node:console';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Marked, Renderer } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenNames = new Set(['.data', '.git', '.cache', '.tools']);
const guideSource = 'docs/customer-setup.md';

function requireInput(path, kind = 'file') {
  if (!existsSync(path)) throw new Error(`Required ${kind} is missing: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Expected an ordinary ${kind}, not a link: ${path}`);
  }
}

function copyInput(source, destination, skipNestedModules = false) {
  cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter(path) {
      const parts = relative(source, path).split(sep);
      if (parts.some((part) => forbiddenNames.has(part) || part.startsWith('.env'))) return false;
      if (skipNestedModules && parts.includes('node_modules')) return false;
      if (lstatSync(path).isSymbolicLink())
        throw new Error(`Package inputs cannot contain links: ${path}`);
      return true;
    },
  });
}

function writeNew(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: 'wx' });
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function guidePage(body, sections, build) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>Stockbridge setup and daily use</title>
<style>
body{font:17px/1.65 system-ui,Segoe UI,sans-serif;color:#24312c;background:#f6f8f5;margin:0;padding:28px}
main{max-width:980px;margin:auto;background:white;padding:32px;border:1px solid #dce4da;border-radius:12px}
h1,h2,h3{line-height:1.25;color:#17382b}h2{margin-top:2em}a{color:#075f42;text-underline-offset:3px}
nav{margin:20px 0}nav summary{cursor:pointer;font-weight:600}pre{overflow:auto;padding:18px;background:#f2f5f1;border-radius:6px}
code{font-size:.9em;overflow-wrap:anywhere}table{border-collapse:collapse;display:block;overflow:auto;margin:20px 0}
th,td{border:1px solid #dce4da;text-align:left;vertical-align:top;padding:10px}th{background:#eef3ec}
img{max-width:100%}blockquote,.pilot{padding:12px 18px;border-left:4px solid #b18c31;background:#fff9e8}
.build{color:#5c665e;font-size:14px}li{margin:8px 0}@media(max-width:600px){body{padding:10px}main{padding:18px}}
</style></head><body><main>
<p class="pilot"><strong>Live workspace.</strong> Stockbridge reads Tally. On Flipkart, approved actions can change stock or prices. Enabling company sync allows automatic stock updates.</p>
<p class="build">Version ${escapeHtml(build.version)} · ${escapeHtml(build.commit.slice(0, 12))}${build.dirty ? ' · includes uncommitted changes' : ''} · built ${escapeHtml(build.createdAt)}</p>
<nav aria-label="Guide sections"><details><summary>Jump to a section</summary><ul>${sections.join('')}</ul></details></nav>
${body}
</main></body></html>\n`;
}

function createCustomerGuide(folder, build) {
  const ids = new Set();
  const sections = [];
  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const plain = this.parser.parseInline(tokens, this.parser.textRenderer);
    const base =
      plain
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    let id = base;
    let duplicate = 0;
    while (ids.has(id)) id = `${base}-${++duplicate}`;
    ids.add(id);
    if (depth === 2)
      sections.push(`<li><a href="#${escapeHtml(id)}">${escapeHtml(plain)}</a></li>`);
    return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
  };
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function ({ href, title, tokens }) {
    if (!href.startsWith('#') && !/^https?:\/\//i.test(href))
      throw new Error(`The offline setup guide references a file outside the guide: ${href}`);
    const label = this.parser.parseInline(tokens);
    return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} rel="noreferrer">${label}</a>`;
  };
  const body = new Marked({ renderer, gfm: true }).parse(
    readFileSync(join(root, guideSource), 'utf8'),
  );
  writeNew(join(folder, 'Read Me.html'), guidePage(body, sections, build));
}

function createLaunchers(folder) {
  const actions = {
    'Start Stockbridge.cmd': 'start',
    'Stop Stockbridge.cmd': 'stop',
    'Stockbridge Status.cmd': 'status',
    'Open Data Folder.cmd': 'data',
  };
  for (const [filename, action] of Object.entries(actions)) {
    writeNew(
      join(folder, filename),
      [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        `"%~dp0runtime\\node.exe" "%~dp0scripts\\windows-launcher.mjs" ${action}`,
        'set "stockbridgeExitCode=%errorlevel%"',
        action === 'start' ? 'if not "%stockbridgeExitCode%"=="0" pause' : 'pause',
        'exit /b %stockbridgeExitCode%',
        '',
      ].join('\r\n'),
    );
  }
}

function packagePilot() {
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    !/^v24\.\d+\.\d+$/.test(process.version)
  ) {
    throw new Error('Build the Windows x64 pilot with Node.js 24 on Windows x64.');
  }
  const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages) throw new Error('The package lockfile must record installed package paths.');
  if (!/^[\w.+-]+$/.test(packageInfo.version) || lock.version !== packageInfo.version) {
    throw new Error('The package and lockfile must have the same valid release version.');
  }
  const nodeDirectory = resolve(
    process.env.STOCKBRIDGE_NODE_DIR || join(root, '.tools', `node-${process.version}-win-x64`),
  );
  const nodeExecutable = join(nodeDirectory, 'node.exe');
  requireInput(nodeExecutable);
  requireInput(join(nodeDirectory, 'LICENSE'));
  const runtime = JSON.parse(
    execFileSync(
      nodeExecutable,
      [
        '-p',
        'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})',
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  if (
    runtime.version !== process.version ||
    runtime.platform !== 'win32' ||
    runtime.arch !== 'x64'
  ) {
    throw new Error(
      `Bundled Node must match ${process.version} and Windows x64; received ${JSON.stringify(runtime)}.`,
    );
  }
  const inputs = [
    'dist/src/server/main.js',
    'dist/web/index.html',
    'scripts/windows-launcher.mjs',
    'scripts/restore-pilot.mjs',
    guideSource,
  ];
  for (const input of inputs) requireInput(join(root, input));
  requireInput(join(root, 'node_modules'), 'directory');
  const dependencies = Object.entries(lock.packages)
    .filter(([path, value]) => path && !value.dev)
    .map(([path, value]) => {
      if (
        !path.startsWith('node_modules/') ||
        path.includes('\\') ||
        posix.normalize(path) !== path ||
        path.split('/').some((part) => part === '..' || part === '.')
      )
        throw new Error(`Unsupported dependency path: ${path}`);
      const directory = join(root, path);
      requireInput(directory, 'directory');
      if (!realpathSync(directory).startsWith(realpathSync(join(root, 'node_modules')) + sep)) {
        throw new Error(`Dependency must stay inside this checkout's node_modules: ${path}`);
      }
      requireInput(join(directory, 'package.json'));
      const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (installed.version !== value.version)
        throw new Error(
          `Dependency ${path} is ${installed.version}, but the lockfile requires ${value.version}. Run npm ci before packaging.`,
        );
      return { path, name: installed.name, version: installed.version };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const name of Object.keys(packageInfo.dependencies ?? {})) {
    if (!dependencies.some((dependency) => dependency.path === `node_modules/${name}`))
      throw new Error(`Runtime dependency is absent from the lockfile: ${name}`);
  }
  const commit = git('rev-parse', 'HEAD');
  const build = {
    version: packageInfo.version,
    createdAt: new Date().toISOString(),
    commit,
    dirty: !!git('status', '--porcelain'),
  };
  const ignoreCheck = spawnSync('git', ['check-ignore', '--', 'releases/'], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (ignoreCheck.error || ignoreCheck.status !== 0)
    throw new Error('Add releases/ to .gitignore before packaging.');
  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true });
  requireInput(releases, 'directory');
  const name = `Stockbridge-Pilot-${build.version}-${build.createdAt.replace(/[:.]/g, '-')}-${commit.slice(0, 8)}${build.dirty ? '-dirty' : ''}-win-x64`;
  const folder = join(releases, name);
  const zip = `${folder}.zip`;
  if (existsSync(folder) || existsSync(zip))
    throw new Error(`Release output already exists: ${folder}`);
  mkdirSync(folder);
  // Select compiled modules from current source so deleted files left in dist cannot ship.
  for (const source of readdirSync(join(root, 'src'), { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(source)) continue;
    const compiled = join('dist', 'src', source.replace(/\.tsx?$/, '.js'));
    requireInput(join(root, compiled));
    mkdirSync(dirname(join(folder, compiled)), { recursive: true });
    copyFileSync(join(root, compiled), join(folder, compiled), constants.COPYFILE_EXCL);
  }
  copyInput(join(root, 'dist/web'), join(folder, 'dist/web'));
  for (const file of [
    'package.json',
    'package-lock.json',
    'scripts/windows-launcher.mjs',
    'scripts/restore-pilot.mjs',
  ]) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    copyFileSync(join(root, file), join(folder, file), constants.COPYFILE_EXCL);
  }
  mkdirSync(join(folder, 'runtime'));
  copyFileSync(nodeExecutable, join(folder, 'runtime/node.exe'), constants.COPYFILE_EXCL);
  copyFileSync(
    join(nodeDirectory, 'LICENSE'),
    join(folder, 'runtime/LICENSE'),
    constants.COPYFILE_EXCL,
  );
  for (const dependency of dependencies)
    copyInput(join(root, dependency.path), join(folder, dependency.path), true);
  createLaunchers(folder);
  createCustomerGuide(folder, build);
  const files = readdirSync(folder, { recursive: true })
    .filter((file) => statSync(join(folder, file)).isFile())
    .sort()
    .map((file) => ({
      path: file.replaceAll('\\', '/'),
      bytes: statSync(join(folder, file)).size,
      sha256: sha256(join(folder, file)),
    }));
  writeNew(
    join(folder, 'manifest.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        purpose:
          'Windows pilot for reading Tally stock and managing Flipkart listings. Reviewed actions can change live stock or prices. Company sync can update live stock automatically.',
        ...build,
        runtime,
        dependencies,
        checksumScope:
          'Every packaged file except manifest.json itself; the ZIP has a separate SHA256 sidecar.',
        files,
      },
      null,
      2,
    ) + '\n',
  );
  const archive = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '[System.IO.Compression.ZipFile]::CreateFromDirectory($env:STOCKBRIDGE_PACKAGE_FOLDER, $env:STOCKBRIDGE_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)',
      ].join('\n'),
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, STOCKBRIDGE_PACKAGE_FOLDER: folder, STOCKBRIDGE_PACKAGE_ZIP: zip },
    },
  );
  if (archive.error || archive.status !== 0)
    throw new Error(
      `Could not create ZIP. The new staging folder was retained for inspection. ${archive.error?.message || archive.stderr.trim()}`,
    );
  writeNew(`${zip}.sha256`, `${sha256(zip)}  ${name}.zip\n`);
  log(zip);
}

try {
  packagePilot();
} catch (cause) {
  error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
