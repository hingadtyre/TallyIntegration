import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type WorkspaceMode = 'live' | 'demo';

export interface RuntimeRecord<Mode extends WorkspaceMode> {
  application: 'stockbridge';
  mode: Mode;
  version: string;
  instanceId: string;
  pid: number;
  url: string;
  token: string;
}

export function createRuntimeControl<Mode extends WorkspaceMode>(mode: Mode, port: number) {
  const dashboardUrl = 'http://127.0.0.1:' + port;
  const name = mode === 'demo' ? 'Stockbridge demo' : 'Stockbridge';

  /** Only the expected mode and loopback address may receive the private control token. */
  function parseRuntimeRecord(value: unknown): RuntimeRecord<Mode> {
    if (!value || typeof value !== 'object') throw new Error('Invalid application status file.');
    const record = value as Partial<RuntimeRecord<Mode>>;
    if (
      record.application !== 'stockbridge' ||
      record.mode !== mode ||
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
    return record as RuntimeRecord<Mode>;
  }

  function readRecord(dataDirectory: string): RuntimeRecord<Mode> | null {
    const file = join(dataDirectory, mode + '.runtime.json');
    try {
      return parseRuntimeRecord(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError)
        throw new Error('Invalid application status file.', { cause: error });
      throw error;
    }
  }

  async function instanceResponds(
    record: RuntimeRecord<Mode>,
    request: typeof fetch = fetch,
  ): Promise<boolean> {
    try {
      const response = await request(dashboardUrl + '/api/health', {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      if (!response.ok) return false;
      const health = (await response.json()) as Partial<RuntimeRecord<Mode>>;
      return (
        health.application === 'stockbridge' &&
        health.mode === mode &&
        health.instanceId === record.instanceId
      );
    } catch {
      return false;
    }
  }

  async function stopVerifiedInstance(dataDirectory: string, record: RuntimeRecord<Mode>) {
    const response = await fetch(dashboardUrl + '/api/runtime/stop', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + record.token,
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(name + ' did not accept the stop request. Contact support.');
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(250);
      if (readRecord(dataDirectory)?.instanceId !== record.instanceId) {
        console.log(name + ' stopped. Saved data was retained.');
        return;
      }
    }
    throw new Error(
      mode === 'demo'
        ? 'Stockbridge demo is still finishing a task. Wait and run npm run demo:stop again.'
        : 'Stockbridge is still finishing a task. Wait and check Status before updating files.',
    );
  }

  return { dashboardUrl, parseRuntimeRecord, readRecord, instanceResponds, stopVerifiedInstance };
}

export async function stopDemo(dataDirectory: string): Promise<void> {
  if (
    !isAbsolute(dataDirectory) ||
    dataDirectory.includes('\0') ||
    dataDirectory.replaceAll('\\', '/').startsWith('//') ||
    (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(dataDirectory))
  ) {
    throw new Error('The demo data folder must be an absolute local folder.');
  }
  const demo = createRuntimeControl('demo', 4311);
  const record = demo.readRecord(dataDirectory);
  if (!record) {
    console.log('Stockbridge demo is already stopped for this data folder.');
    return;
  }
  if (!(await demo.instanceResponds(record))) {
    throw new Error('Could not verify the running Stockbridge demo. It may already be stopping.');
  }
  await demo.stopVerifiedInstance(dataDirectory, record);
}
