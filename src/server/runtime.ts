import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createOwnershipServer, type Server as OwnershipServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostics } from './diagnostics.js';
import { FlipkartConnection } from './flipkart-connection.js';
import { createApp, type RuntimeHealth } from './http.js';
import { InventoryService } from './service.js';
import { Store } from './store.js';

type WorkspaceMode = 'live' | 'demo';

export interface RuntimePaths {
  appRoot: string;
  webRoot: string;
  dataDirectory: string;
}

export interface RuntimeRecord extends RuntimeHealth {
  pid: number;
  url: string;
  token: string;
}

function requireLocalAbsolutePath(path: string): void {
  if (!isAbsolute(path) || path.includes('\0') || path.replaceAll('\\', '/').startsWith('//')) {
    throw new Error(
      'STOCKBRIDGE_DATA_DIR must be an absolute local folder, not a network or device path.',
    );
  }
}

export function resolveRuntimePaths(
  dataDirectory?: string,
  moduleUrl = import.meta.url,
): RuntimePaths {
  const appRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../../..');
  const selectedDirectory = dataDirectory ?? join(appRoot, '.data');
  requireLocalAbsolutePath(selectedDirectory);
  return {
    appRoot,
    webRoot: join(appRoot, 'dist', 'web'),
    dataDirectory: resolve(selectedDirectory),
  };
}

/** The operating system releases this ownership when a process exits, including a crash. */
export async function acquireWorkspaceOwnership(
  dataDirectory: string,
  mode: WorkspaceMode,
): Promise<{
  dataDirectory: string;
  release(): Promise<void>;
}> {
  requireLocalAbsolutePath(dataDirectory);
  mkdirSync(dataDirectory, { recursive: true });
  const canonicalDirectory = realpathSync.native(dataDirectory);
  requireLocalAbsolutePath(canonicalDirectory);
  const identity =
    process.platform === 'win32' ? canonicalDirectory.toLowerCase() : canonicalDirectory;
  const key = createHash('sha256').update(`${identity}\0${mode}`).digest('hex');
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\stockbridge-${key}`
      : process.platform === 'linux'
        ? `\0stockbridge-${key}`
        : null;
  if (address === null)
    throw new Error('Stockbridge workspace ownership currently supports Windows and Linux.');
  const owner = createOwnershipServer((connection) => connection.destroy());
  try {
    await new Promise<void>((accept, reject) => {
      owner.once('error', reject);
      owner.listen(address, () => {
        owner.off('error', reject);
        accept();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Stockbridge ${mode} is already running for this data folder. Open its dashboard or stop that instance before starting another.`,
        { cause: error },
      );
    }
    throw new Error(
      'Could not reserve this Stockbridge workspace. Check the data folder and Windows permissions.',
      { cause: error },
    );
  }
  let released: Promise<void> | undefined;
  return {
    dataDirectory: canonicalDirectory,
    release() {
      return (released ??= closeOwnership(owner));
    },
  };
}

function closeOwnership(owner: OwnershipServer): Promise<void> {
  return new Promise((accept, reject) =>
    owner.close((error) => (error ? reject(error) : accept())),
  );
}

function removeOwnRuntimeRecord(file: string, instanceId: string): void {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      saved &&
      typeof saved === 'object' &&
      'instanceId' in saved &&
      saved.instanceId === instanceId
    )
      rmSync(file);
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
}

export async function startRuntime(
  options: {
    mode?: WorkspaceMode;
    dataDirectory?: string;
    port?: number;
  } = {},
): Promise<{ record: RuntimeRecord; stop(): Promise<void> }> {
  const mode = options.mode ?? 'live';
  const paths = resolveRuntimePaths(options.dataDirectory ?? process.env.STOCKBRIDGE_DATA_DIR);
  const packageInfo = JSON.parse(readFileSync(join(paths.appRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageInfo.version !== 'string')
    throw new Error(
      'Stockbridge application version is missing. Reinstall the application package.',
    );
  const owner = await acquireWorkspaceOwnership(paths.dataDirectory, mode);
  const runtimeFile = join(owner.dataDirectory, `${mode}.runtime.json`);
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const health: RuntimeHealth = {
    application: 'stockbridge',
    version: packageInfo.version,
    mode,
    instanceId,
    publishingEnabled: false,
  };
  let store: Store | undefined;
  let service: InventoryService | undefined;
  let flipkart: FlipkartConnection | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let stopping: Promise<void> | undefined;
  const diagnostics = new Diagnostics(join(owner.dataDirectory, `${mode}.diagnostics.ndjson`));

  async function waitForPendingWork(): Promise<void> {
    const results = await Promise.allSettled([service?.idle(), flipkart?.idle()]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async function cleanup(): Promise<void> {
    try {
      try {
        service?.stop();
        flipkart?.stop();
      } finally {
        if (app?.listening) {
          await new Promise<void>((accept, reject) =>
            app!.close((error) => (error ? reject(error) : accept())),
          );
        }
      }
    } finally {
      try {
        try {
          await waitForPendingWork();
        } finally {
          store?.close();
        }
      } finally {
        try {
          removeOwnRuntimeRecord(runtimeFile, instanceId);
        } finally {
          await owner.release();
        }
      }
    }
  }

  function stop(): Promise<void> {
    return (stopping ??= cleanup());
  }

  try {
    store = new Store(join(owner.dataDirectory, `${mode}.sqlite`), mode);
    service = new InventoryService(store, { diagnostics });
    flipkart = new FlipkartConnection(owner.dataDirectory, mode);
    app = createApp(
      service,
      paths.webRoot,
      {
        health,
        stopToken: token,
        requestStop() {
          void stop().catch((error) => {
            diagnostics.error('shutdown', error);
            console.error(
              'Stockbridge could not finish shutting down. Check its diagnostic log before restarting.',
            );
            process.exitCode = 1;
          });
        },
      },
      flipkart,
    );
    const server = app;
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? (mode === 'demo' ? 4311 : 4310), '127.0.0.1', () => {
        server.off('error', reject);
        accept();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Stockbridge did not open its local dashboard.');
    const record: RuntimeRecord = {
      ...health,
      pid: process.pid,
      url: `http://127.0.0.1:${address.port}`,
      token,
    };
    const temporaryFile = join(owner.dataDirectory, `${mode}.runtime.${instanceId}.tmp`);
    try {
      writeFileSync(temporaryFile, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(temporaryFile, runtimeFile);
    } finally {
      rmSync(temporaryFile, { force: true });
    }
    service.start();
    service.log('startup', `${mode} dashboard started; marketplace publishing disabled.`);
    server.on('error', (error) => {
      diagnostics.error('http-server', error);
      void stop().catch((shutdownError) => diagnostics.error('shutdown', shutdownError));
      process.exitCode = 1;
    });
    return { record, stop };
  } catch (error) {
    await stop();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Dashboard port ${options.port ?? (mode === 'demo' ? 4311 : 4310)} is already in use. Stop the existing application or choose the correct workspace.`,
        { cause: error },
      );
    }
    throw error;
  }
}
