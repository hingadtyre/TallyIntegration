import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveDashboardPort } from '../shared/dashboard-port.js';
import { installDesktopShortcut } from './shortcut.js';

const dashboardUrl = `http://127.0.0.1:${liveDashboardPort()}`;

export interface RuntimeRecord {
  application: 'stockbridge';
  mode: 'live';
  version: string;
  instanceId: string;
  pid: number;
  url: string;
  token: string;
}

/** Never send a control token to an address supplied by an unvalidated file. */
export function parseRuntimeRecord(value: unknown): RuntimeRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid application status file.');
  const record = value as Partial<RuntimeRecord>;
  if (
    record.application !== 'stockbridge' ||
    record.mode !== 'live' ||
    record.url !== dashboardUrl ||
    typeof record.version !== 'string' ||
    typeof record.instanceId !== 'string' ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(record.instanceId) ||
    typeof record.token !== 'string' ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid! <= 0
  ) {
    throw new Error('Invalid application status file. Contact support; no process was stopped.');
  }
  return record as RuntimeRecord;
}

export async function instanceResponds(
  record: RuntimeRecord,
  request: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await request(`${dashboardUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (!response.ok) return false;
    const health = (await response.json()) as Partial<RuntimeRecord>;
    return (
      health.application === 'stockbridge' &&
      health.mode === 'live' &&
      health.instanceId === record.instanceId
    );
  } catch {
    return false;
  }
}

function readRecord(dataDirectory: string): RuntimeRecord | null {
  const file = join(dataDirectory, 'live.runtime.json');
  try {
    return parseRuntimeRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function openWindow(program: string, args: string[]): void {
  const child = spawn(program, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Could not open the window. Dashboard: ${dashboardUrl}`));
  child.unref();
}

export async function runLauncher(
  action: string,
  options: { packageRoot: string; openBrowser?: boolean },
): Promise<void> {
  const configured =
    process.env.STOCKBRIDGE_DATA_DIR ??
    (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Stockbridge', 'Pilot', 'data'));
  if (!configured || !isAbsolute(configured) || /^\\\\|^\/\//.test(configured)) {
    throw new Error('Use a local Windows data folder. Contact support to check the installation.');
  }
  const dataDirectory = resolve(configured);
  if (!['start', 'upgrade', 'stop', 'status', 'data'].includes(action)) {
    throw new Error(
      'Choose Start Stockbridge, Upgrade Stockbridge, Stop Stockbridge, Stockbridge Status or Open Data Folder.',
    );
  }
  if (action === 'data') {
    mkdirSync(dataDirectory, { recursive: true });
    openWindow('explorer.exe', [dataDirectory]);
    return;
  }

  const record = readRecord(dataDirectory);
  const running = record !== null && (await instanceResponds(record));
  const executable = join(options.packageRoot, 'runtime', 'node.exe');
  const entry = join(options.packageRoot, 'dist', 'src', 'server', 'main.js');
  if (
    (action === 'upgrade' || (action === 'start' && !running)) &&
    (!existsSync(executable) ||
      !existsSync(entry) ||
      !existsSync(join(options.packageRoot, 'dist/web/index.html')))
  ) {
    throw new Error(
      'Application files are missing. Extract the entire ZIP before starting Stockbridge.',
    );
  }
  const file = join(dataDirectory, 'live.sqlite');
  if (action === 'upgrade' && !statSync(file, { throwIfNoEntry: false })?.isFile())
    throw new Error(
      `No existing Stockbridge workspace found in ${dataDirectory}. Check the Windows login and the data folder shown by the old Stockbridge Status command.`,
    );
  if (action === 'status') {
    console.log(
      running
        ? `Stockbridge ${record!.version} is running.`
        : record
          ? 'Stockbridge is not responding or is still stopping. Do not update files yet; contact support if this persists.'
          : 'Stockbridge is not running.',
    );
    console.log(`Dashboard: ${dashboardUrl}\nData folder: ${dataDirectory}`);
    console.log(
      'Stockbridge reads Tally stock. Reviewed changes and enabled automatic updates can publish stock to Flipkart.',
    );
    return;
  }
  if (action === 'stop' || (action === 'upgrade' && running)) {
    if (!record) {
      console.log('Stockbridge is already stopped.');
      return;
    }
    if (!running) {
      console.log('No matching Stockbridge instance is responding. No other process was stopped.');
      return;
    }
    const response = await fetch(`${dashboardUrl}/api/runtime/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${record.token}`,
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error('Stockbridge did not accept the stop request. Contact support.');
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(250);
      const current = readRecord(dataDirectory);
      if (!current || current.instanceId !== record.instanceId) {
        console.log('Stockbridge stopped. Saved data was retained.');
        break;
      }
    }
    if (readRecord(dataDirectory)?.instanceId === record.instanceId)
      throw new Error(
        'Stockbridge is still finishing a task. Wait and check Status before updating files.',
      );
    if (action === 'stop') return;
  }

  if (!running || action === 'upgrade') {
    let safetyCopy: string | null = null;
    if (action === 'upgrade') {
      const { DatabaseSync } = await import('node:sqlite');
      const { acquireWorkspaceOwnership } = await import('../server/runtime.js');
      const { prepareDatabase } = await import('../server/storage/migrations.js');
      const owner = await acquireWorkspaceOwnership(dataDirectory, 'live');
      try {
        const database = new DatabaseSync(file);
        try {
          database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
          safetyCopy = prepareDatabase(database, file, 'live', true);
          console.log(
            `Verified safety copy: ${safetyCopy}\nExisting workspace is ready: ${dataDirectory}`,
          );
        } finally {
          database.close();
        }
      } finally {
        await owner.release();
      }
    }
    try {
      mkdirSync(dataDirectory, { recursive: true });
      const logFile = join(dataDirectory, 'startup.log');
      const log = openSync(logFile, 'a');
      let startedPid: number | undefined;
      try {
        const child = spawn(executable, [entry], {
          cwd: options.packageRoot,
          env: { ...process.env, STOCKBRIDGE_DATA_DIR: dataDirectory },
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log, log],
        });
        await new Promise<void>((accept, reject) => {
          child.once('spawn', accept);
          child.once('error', reject);
        });
        startedPid = child.pid;
        child.unref();
      } finally {
        closeSync(log);
      }
      let ready = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await delay(250);
        const current = readRecord(dataDirectory);
        if (
          current &&
          (action !== 'upgrade' || current.pid === startedPid) &&
          (await instanceResponds(current))
        ) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        throw new Error(`Stockbridge could not start. Share the error in ${logFile} with support.`);
      }
    } catch (failure) {
      if (!safetyCopy) throw failure;
      throw new Error(
        `The workspace upgrade completed, but startup of the new dashboard could not be confirmed. Run Upgrade Stockbridge.cmd again from the new folder. If this persists, contact support.\nVerified safety copy: ${safetyCopy}\nStartup log: ${join(dataDirectory, 'startup.log')}`,
        { cause: failure },
      );
    }
    if (action === 'upgrade') installDesktopShortcut(options.packageRoot, dataDirectory);
  }
  console.log(`Stockbridge is running at ${dashboardUrl}. Closing the browser keeps it running.`);
  if (options.openBrowser !== false) {
    openWindow('rundll32.exe', ['url.dll,FileProtocolHandler', dashboardUrl]);
  }
}
