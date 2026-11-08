import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { InventoryService } from './service.js';
import { InputError } from './validation.js';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

export interface RuntimeHealth {
  application: 'stockbridge';
  version: string;
  mode: 'live' | 'demo';
  instanceId: string;
  publishingEnabled: false;
}

interface RuntimeControl {
  health: RuntimeHealth;
  stopToken: string;
  requestStop(): void;
}

function requireRuntimeAuthorization(request: IncomingMessage, token: string): void {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InputError('This action requires the current app instance authorization.', 403);
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100_000) throw new InputError('Request too large.', 413);
    chunks.push(chunk);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new InputError('Send a JSON object.');
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function requireDashboardRequest(request: IncomingMessage): void {
  if (
    request.headers['x-stockbridge-request'] !== '1' ||
    !request.headers['content-type']?.startsWith('application/json')
  ) {
    throw new InputError('Use the local dashboard for this action.', 403);
  }
  if (
    request.headers.origin &&
    !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.origin)
  ) {
    throw new InputError('Untrusted page origin.', 403);
  }
}

async function runCommand(
  service: InventoryService,
  path: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (path) {
    case '/api/refresh':
      return service.refresh(input.companyId);
    case '/api/calculate':
      return service.calculate(input.companyId, input.listingIds);
    case '/api/zero':
      return service.calculate(input.companyId, input.listingIds, true);
    case '/api/proposals':
      return service.edit(input.companyId, input.listingId, input.quantity);
    case '/api/pause':
      return service.pause(input.companyId, input.listingIds, input.paused);
    case '/api/review':
      return service.review(input.companyId, input.listingIds);
    case '/api/settings':
      return service.settings(input.settings);
    case '/api/mappings':
      return service.mapping(input);
    case '/api/mappings/remove':
      return service.remove(input.companyId, input.listingId, input.leaveRemoteStock);
    case '/api/backup':
      return service.backup();
    case '/api/publish':
      throw new InputError(
        'Marketplace publishing is unavailable until authenticated integration validation is complete.',
        409,
      );
    default:
      throw new InputError('Route not found.', 404);
  }
}

async function sendAsset(response: ServerResponse, webRoot: string, path: string): Promise<void> {
  const root = resolve(webRoot);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path === '/' ? '/index.html' : path);
  } catch {
    throw new InputError('Invalid page address.');
  }
  const target = resolve(root, '.' + decodedPath);
  if (!target.startsWith(root + sep)) throw new InputError('Route not found.', 404);
  const content = await readFile(target);
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(target)] ?? 'application/octet-stream',
  });
  response.end(content);
}

export function createApp(
  service: InventoryService,
  webRoot = resolve('dist/web'),
  runtime?: RuntimeControl,
) {
  return createServer(async (request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    let path = '/';
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? ''))
        throw new InputError('Local access only.', 403);
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path.startsWith('/api/')) {
        if (request.method === 'GET' && path === '/api/health' && runtime)
          return sendJson(response, 200, runtime.health);
        if (request.method === 'GET' && path === '/api/state')
          return sendJson(response, 200, service.snapshot());
        if (request.method === 'GET' && path === '/api/logs') {
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(service.logs());
          return;
        }
        if (request.method !== 'POST') throw new InputError('Route not found.', 404);
        requireDashboardRequest(request);
        if (path === '/api/runtime/stop' && runtime) {
          requireRuntimeAuthorization(request, runtime.stopToken);
          await readJsonObject(request);
          response.once('finish', () => runtime.requestStop());
          return sendJson(response, 200, { stopping: true, instanceId: runtime.health.instanceId });
        }
        const input = await readJsonObject(request);
        const result = await runCommand(service, path, input);
        service.log(path, `Completed in ${Date.now() - started} ms`, 'info', requestId);
        sendJson(response, 200, result);
        return;
      }
      if (request.method !== 'GET') throw new InputError('Route not found.', 404);
      await sendAsset(response, webRoot, path);
    } catch (error) {
      const missingAsset =
        !path.startsWith('/api/') &&
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      const status = error instanceof InputError ? error.status : missingAsset ? 404 : 500;
      let message: string;
      if (error instanceof InputError) message = error.message;
      else if (missingAsset) message = 'Page not found. Run the app build first.';
      else
        message = `The action could not be completed. Check Diagnostics with reference ${requestId}.`;
      if (status >= 500) service.diagnostics.error(path, error, requestId);
      else service.log(path, `${status}: ${message}`, 'warning', requestId);
      sendJson(response, status, { error: message, requestId });
    }
  });
}
