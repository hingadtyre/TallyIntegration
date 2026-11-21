import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveDashboardPort } from '../shared/dashboard-port.js';

// Pass paths as data so names containing spaces and shell metacharacters stay literal.
const updateShortcut = `
$ErrorActionPreference = 'Stop'
$desktop = $env:STOCKBRIDGE_DESKTOP_DIR
if (!$desktop) { $desktop = [Environment]::GetFolderPath('DesktopDirectory') }
if (!$desktop -or ![IO.Directory]::Exists($desktop)) { throw 'Desktop is unavailable.' }
$file = Join-Path $desktop 'Stockbridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$marker = 'Stockbridge managed desktop shortcut'
$exists = [IO.File]::Exists($file)
if ($exists) {
  $old = $shell.CreateShortcut($file)
  if ($old.Description -ne $marker) {
    Write-Output 'The name Stockbridge is already in use on your desktop. Use Start Stockbridge.cmd in the new folder.'
    exit 0
  }
}
$temp = Join-Path $desktop ([Guid]::NewGuid().ToString() + '.lnk')
try {
  $link = $shell.CreateShortcut($temp)
  $link.TargetPath = Join-Path $env:STOCKBRIDGE_SHORTCUT_ROOT 'runtime/node.exe'
  $link.Arguments = $env:STOCKBRIDGE_SHORTCUT_ARGS
  $link.WorkingDirectory = $env:STOCKBRIDGE_SHORTCUT_ROOT
  $link.Description = $marker
  $link.Save()
  if ($exists) {
    for ($attempt = 1; ; $attempt++) {
      try {
        if ($shell.CreateShortcut($file).Description -ne $marker) {
          Write-Output 'The name Stockbridge is already in use on your desktop. Use Start Stockbridge.cmd in the new folder.'
          exit 0
        }
        [IO.File]::Replace($temp, $file, [System.Management.Automation.Language.NullString]::Value)
        break
      } catch {
        if ($attempt -ge 3) { throw }
        Start-Sleep -Milliseconds 250
      }
    }
  }
  else { [IO.File]::Move($temp, $file) }
} finally {
  if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
}
Write-Output 'The Stockbridge desktop shortcut is ready.'
`;

export function installDesktopShortcut(packageRoot: string, dataDirectory: string): void {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const script = join(packageRoot, 'scripts/windows-launcher.mjs');
  try {
    const message = execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(updateShortcut, 'utf16le').toString('base64'),
      ],
      {
        env: {
          ...process.env,
          STOCKBRIDGE_SHORTCUT_ROOT: packageRoot,
          STOCKBRIDGE_SHORTCUT_ARGS: `"${script}" start --workspace "${pathToFileURL(dataDirectory).href}" --port ${liveDashboardPort()}`,
        },
        windowsHide: true,
        timeout: 15000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    console.log(message.trim());
  } catch {
    console.warn(
      'The desktop shortcut could not be updated. Use Start Stockbridge.cmd in the new folder.',
    );
  }
}
