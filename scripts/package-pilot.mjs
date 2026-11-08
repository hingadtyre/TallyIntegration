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
const rootDocuments = ['README.md', 'CONTRIBUTING.md', 'GLOSSARY.md'];

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

function relativeUrl(fromFile, toFile) {
  return posix
    .relative(posix.dirname(fromFile), toFile)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function page(title, body, outputPath, build) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)} | Stockbridge pilot</title>
<style>
body{font:17px/1.65 system-ui,Segoe UI,sans-serif;color:#24312c;background:#f6f8f5;margin:0;padding:28px}
main{max-width:980px;margin:auto;background:white;padding:32px;border:1px solid #dce4da;border-radius:12px}
h1,h2,h3{line-height:1.25;color:#17382b}h2{margin-top:2em}a{color:#075f42;text-underline-offset:3px}
nav{display:flex;gap:20px;margin-bottom:20px}pre{overflow:auto;padding:18px;background:#f2f5f1;border-radius:6px}
code{font-size:.9em;overflow-wrap:anywhere}table{border-collapse:collapse;display:block;overflow:auto;margin:20px 0}
th,td{border:1px solid #dce4da;text-align:left;vertical-align:top;padding:10px}th{background:#eef3ec}
img{max-width:100%}blockquote,.pilot{padding:12px 18px;border-left:4px solid #b18c31;background:#fff9e8}
.build{color:#5c665e;font-size:14px}li{margin:8px 0}@media(max-width:600px){body{padding:10px}main{padding:18px}}
</style></head><body><main>
<nav><a href="${relativeUrl(outputPath, 'Read Me.html')}">Setup guide</a><a href="${relativeUrl(outputPath, 'documentation/index.html')}">All documentation</a></nav>
<p class="pilot"><strong>Read-only pilot.</strong> Tally stock review and manual backups are available. Flipkart connection and marketplace publication are not available.</p>
<p class="build">Version ${escapeHtml(build.version)} · ${escapeHtml(build.commit.slice(0, 12))}${build.dirty ? ' · includes uncommitted changes' : ''} · built ${escapeHtml(build.createdAt)}</p>
${body}
</main></body></html>\n`;
}

function createDocumentation(folder, build) {
  const committedFiles = new Set(git('ls-tree', '-r', '--name-only', build.commit).split('\n'));
  const documents = [
    ...rootDocuments,
    ...readdirSync(join(root, 'docs'), { recursive: true })
      .filter(
        (file) =>
          file.endsWith('.md') &&
          !file.split(/[\\/]/).some((part) => forbiddenNames.has(part) || part.startsWith('.env')),
      )
      .map((file) => `docs/${file.replaceAll('\\', '/')}`),
  ].sort();
  const documentSet = new Set(documents);
  const htmlPath = (document) => `documentation/${document.replace(/\.md$/, '.html')}`;

  function render(document, outputPath) {
    const usedIds = new Set();
    const renderer = new Renderer();
    function rewriteLink(href) {
      if (href.startsWith('#')) return href;
      if (/^(https?:|mailto:)/i.test(href)) return href;
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
      const [, pathPart, suffix = ''] = href.match(/^([^?#]*)([?#].*)?$/);
      const decoded = decodeURIComponent(pathPart).replaceAll('\\', '/');
      const target = posix.normalize(
        decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(document), decoded),
      );
      if (target === '..' || target.startsWith('../'))
        throw new Error(`Documentation link leaves the repository: ${document}: ${href}`);
      if (documentSet.has(target)) return relativeUrl(outputPath, htmlPath(target)) + suffix;
      if (
        existsSync(join(root, target)) &&
        statSync(join(root, target)).isDirectory() &&
        (target === 'docs' || target.startsWith('docs/'))
      ) {
        return relativeUrl(outputPath, `documentation/${target}/index.html`) + suffix;
      }
      if (existsSync(join(folder, target))) return relativeUrl(outputPath, target) + suffix;
      // Developer source files are not bundled; keep those references explicit and commit-scoped.
      if (!build.dirty && build.repository && committedFiles.has(target)) {
        return `${build.repository}/blob/${build.commit}/${target.split('/').map(encodeURIComponent).join('/')}${suffix}`;
      }
      // A new, uncommitted source file has no published commit URL. Keep its label as plain text.
      if (existsSync(join(root, target))) return null;
      throw new Error(`Unresolved documentation link: ${document}: ${href}`);
    }
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
      while (usedIds.has(id)) id = `${base}-${++duplicate}`;
      usedIds.add(id);
      return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    };
    renderer.link = function ({ href, title, tokens }) {
      const target = rewriteLink(href);
      const label = this.parser.parseInline(tokens);
      return target
        ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''} rel="noreferrer">${label}</a>`
        : label;
    };
    renderer.image = function ({ href, title, tokens }) {
      const target = rewriteLink(href);
      const label = this.parser.parseInline(tokens, this.parser.textRenderer);
      return target
        ? `<img src="${escapeHtml(target)}" alt="${escapeHtml(label)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`
        : escapeHtml(label);
    };
    renderer.html = ({ text }) => escapeHtml(text);
    const html = new Marked({ renderer, gfm: true }).parse(
      readFileSync(join(root, document), 'utf8'),
    );
    writeNew(join(folder, outputPath), page(document, html, outputPath, build));
  }

  for (const document of documents) render(document, htmlPath(document));
  render('docs/customer-setup.md', 'Read Me.html');
  const directories = new Set(['']);
  for (const document of documents) {
    let directory = posix.dirname(document);
    while (directory !== '.') {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  for (const directory of directories) {
    const outputPath = posix.join('documentation', directory, 'index.html');
    const entries = documents
      .filter((document) => posix.dirname(document) === (directory || '.'))
      .map(
        (document) =>
          `<li><a href="${relativeUrl(outputPath, htmlPath(document))}">${escapeHtml(posix.basename(document, '.md'))}</a></li>`,
      );
    for (const child of directories) {
      if (child && posix.dirname(child) === (directory || '.')) {
        entries.push(
          `<li><a href="${relativeUrl(outputPath, `documentation/${child}/index.html`)}">${escapeHtml(posix.basename(child))}/</a></li>`,
        );
      }
    }
    writeNew(
      join(folder, outputPath),
      page(
        'Documentation',
        `<h1>Documentation${directory ? `: ${escapeHtml(directory)}` : ''}</h1><ul>${entries.join('\n')}</ul>`,
        outputPath,
        build,
      ),
    );
  }
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
    'docs/customer-setup.md',
    ...rootDocuments,
  ];
  for (const input of inputs) requireInput(join(root, input));
  requireInput(join(root, 'docs'), 'directory');
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
  const remote = git('remote', 'get-url', 'origin');
  const github = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  );
  const build = {
    version: packageInfo.version,
    createdAt: new Date().toISOString(),
    commit,
    dirty: !!git('status', '--porcelain'),
    repository: github ? `https://github.com/${github[1]}/${github[2]}` : null,
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
  copyInput(join(root, 'docs'), join(folder, 'docs'));
  for (const file of [
    'package.json',
    'package-lock.json',
    ...rootDocuments,
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
  createDocumentation(folder, build);
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
        purpose: 'Read-only Tally inventory pilot. Marketplace publication is unavailable.',
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
