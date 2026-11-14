import assert from 'node:assert/strict';
import test from 'node:test';
import { act, fireEvent, render, response, screen, waitFor } from '../../support/client-dom.js';
import { FlipkartConnectionPanel } from '../../../src/client/screens/FlipkartConnectionPanel.js';
import type { FlipkartConnectionStatus } from '../../../src/shared/contracts.js';

const empty: FlipkartConnectionStatus = {
  state: 'not-configured',
  checkedAt: null,
  expiresAt: null,
  applicationIdHint: null,
  message: 'No Flipkart API credentials are saved.',
};
const verified: FlipkartConnectionStatus = {
  state: 'verified',
  checkedAt: '2026-11-08T09:00:00Z',
  expiresAt: '2026-11-08T10:00:00Z',
  applicationIdHint: '******app123',
  message: 'API access verified. Seller identity and listings still require verification.',
};

function enterCredentials(id = 'example-app123', secret = 'example-secret456') {
  const applicationId = screen.getByLabelText('Application ID') as HTMLInputElement;
  const applicationSecret = screen.getByLabelText('Application Secret', {
    exact: false,
  }) as HTMLInputElement;
  fireEvent.change(applicationId, { target: { value: id } });
  fireEvent.change(applicationSecret, { target: { value: secret } });
  return { applicationId, applicationSecret };
}

test('sample mode does not load, accept or send Flipkart credentials', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Sample mode must not request a real connection.');
  });
  render(<FlipkartConnectionPanel mode="demo" />);
  assert.ok(screen.getByText('Sample mode does not accept credentials or contact Flipkart.'));
  assert.equal(screen.queryByLabelText('Application ID'), null);
  assert.equal(screen.queryByRole('button', { name: 'Save credentials for later' }), null);
  assert.equal(
    (
      screen.getByRole('button', {
        name: 'Connect Flipkart in the live workspace',
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('verification sends credentials only in the local command and clears inputs after success', async (t) => {
  const requests: { path: string; body: unknown }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/flipkart/connection') return response(empty);
      assert.equal(options?.method, 'POST');
      assert.deepEqual(options?.headers, {
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
      });
      requests.push({ path: String(input), body: JSON.parse(String(options?.body)) });
      return response(verified);
    },
  );
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(empty.message);
  const inputs = enterCredentials();
  assert.equal(inputs.applicationSecret.type, 'password');
  fireEvent.click(screen.getByRole('button', { name: 'Verify and save credentials' }));
  await screen.findByText('API credentials verified');
  assert.deepEqual(requests, [
    {
      path: '/api/flipkart/connect',
      body: { applicationId: 'example-app123', applicationSecret: 'example-secret456' },
    },
  ]);
  assert.equal(inputs.applicationId.value, '');
  assert.equal(inputs.applicationSecret.value, '');
  assert.ok(screen.getByText('******app123'));
  assert.ok(
    screen.getByText(
      /Credential verification does not identify the seller, import listings or change stock/,
    ),
  );
  assert.equal(window.localStorage.length, 0);
});

test('credentials can be saved unchanged for later without a verification request', async (t) => {
  const requests: { path: string; body: unknown }[] = [];
  const saved: FlipkartConnectionStatus = {
    ...verified,
    state: 'needs-attention',
    checkedAt: null,
    expiresAt: null,
    message: 'Credentials saved on this computer. Check access after Flipkart approval.',
  };
  const secret = 'private-test-secret+/:=';
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/flipkart/connection') return response(verified);
      assert.equal(String(input), '/api/flipkart/save');
      assert.equal(options?.method, 'POST');
      requests.push({ path: String(input), body: JSON.parse(String(options?.body)) });
      return response(saved);
    },
  );
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(verified.message);
  const inputs = enterCredentials('example-app123', secret);
  fireEvent.click(screen.getByRole('button', { name: 'Save credentials for later' }));
  await screen.findByText(saved.message);
  assert.deepEqual(requests, [
    {
      path: '/api/flipkart/save',
      body: { applicationId: 'example-app123', applicationSecret: secret },
    },
  ]);
  assert.equal(inputs.applicationId.value, '');
  assert.equal(inputs.applicationSecret.value, '');
  assert.ok(screen.getByText('Needs attention'));
  assert.equal(screen.queryByText('API credentials verified'), null);
  for (const label of ['Last checked', 'Access expires']) {
    assert.equal(
      screen.getByText(label).parentElement?.querySelector('dd')?.textContent,
      'Not yet observed',
    );
  }
  assert.equal(
    (screen.getByRole('button', { name: 'Check saved access' }) as HTMLButtonElement).disabled,
    false,
  );
});

test('a failed save for later preserves existing verified status and masked input for retry', async (t) => {
  let saves = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/flipkart/connection') return response(verified);
    assert.equal(String(input), '/api/flipkart/save');
    saves++;
    return response(
      { error: 'Could not save example-secret456. Check local storage and retry.' },
      503,
    );
  });
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(verified.message);
  const inputs = enterCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Save credentials for later' }));
  const error = await screen.findByRole('alert');
  assert.match(error.textContent ?? '', /Check local storage and retry/);
  assert.doesNotMatch(error.textContent ?? '', /example-secret456/);
  assert.ok(screen.getByText('API credentials verified'));
  assert.ok(screen.getByText('******app123'));
  assert.equal(inputs.applicationId.value, 'example-app123');
  assert.equal(inputs.applicationSecret.type, 'password');
  assert.equal(inputs.applicationSecret.value, 'example-secret456');
  assert.equal(
    screen.getByRole('button', { name: 'Save credentials for later' }).matches(':disabled'),
    false,
  );
  assert.equal(saves, 1);
});

test('a rejected credential replacement preserves the saved connection and permits a corrected retry', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/flipkart/connection') return response(verified);
    assert.equal(String(input), '/api/flipkart/connect');
    return ++attempts === 1
      ? response(
          { error: 'Rejected example-app123 / example-secret456. Check the credentials.' },
          400,
        )
      : response({ ...verified, applicationIdHint: '******new789' });
  });
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(verified.message);
  const inputs = enterCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Verify and save credentials' }));
  const error = await screen.findByRole('alert');
  assert.match(error.textContent ?? '', /Check the credentials/);
  assert.doesNotMatch(error.textContent ?? '', /example-app123|example-secret456/);
  assert.ok(screen.getByText('******app123'));
  assert.ok(screen.getByText('API credentials verified'));
  assert.equal(inputs.applicationSecret.value, 'example-secret456');
  enterCredentials('new-app789', 'new-secret789');
  fireEvent.click(screen.getByRole('button', { name: 'Verify and save credentials' }));
  await screen.findByText('******new789');
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(inputs.applicationSecret.value, '');
  assert.equal(attempts, 2);
});

for (const [action, button] of [
  ['check', 'Check saved access'],
  ['disconnect', 'Disconnect locally'],
] as const) {
  test(`a failed ${action} clears verified access and allows a retry`, async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      if (String(input) === '/api/flipkart/connection') return response(verified);
      assert.equal(String(input), `/api/flipkart/${action}`);
      if (++attempts === 1)
        return response({ error: 'The connection action failed. Please retry.' }, 503);
      return response(action === 'check' ? verified : empty);
    });
    render(<FlipkartConnectionPanel mode="live" />);
    await screen.findByText(verified.message);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await screen.findByText('Needs attention');
    assert.equal(screen.queryByText('API credentials verified'), null);
    assert.ok(screen.getByText('******app123'));
    assert.equal(
      screen.getByText('Access expires').parentElement?.querySelector('dd')?.textContent,
      'Not yet observed',
    );
    assert.match(screen.getByRole('alert').textContent ?? '', /Please retry/);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await screen.findByText(action === 'check' ? 'API credentials verified' : 'Not configured');
    assert.equal(screen.queryByRole('alert'), null);
    assert.equal(attempts, 2);
  });
}

test('saved access can report attention and local disconnect clears saved and unsaved credentials', async (t) => {
  const commands: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/flipkart/connection') return response(verified);
      assert.deepEqual(JSON.parse(String(options?.body)), {});
      commands.push(path);
      if (path === '/api/flipkart/check')
        return response({
          ...verified,
          state: 'needs-attention',
          applicationIdHint: null,
          expiresAt: null,
          message: 'Saved credentials could not be read. Replace or disconnect them locally.',
        });
      assert.equal(path, '/api/flipkart/disconnect');
      return response(empty);
    },
  );
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(verified.message);
  fireEvent.click(screen.getByRole('button', { name: 'Check saved access' }));
  await screen.findByText('Needs attention');
  assert.equal(screen.queryByText('API credentials verified'), null);
  const inputs = enterCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect locally' }));
  await screen.findByText(empty.message);
  assert.equal(screen.queryByText('******app123'), null);
  assert.equal(inputs.applicationId.value, '');
  assert.equal(inputs.applicationSecret.value, '');
  assert.equal(
    (screen.getByRole('button', { name: 'Check saved access' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.deepEqual(commands, ['/api/flipkart/check', '/api/flipkart/disconnect']);
});

test('a failed initial status read exposes retry and does not accept credential submission', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(String(input), '/api/flipkart/connection');
    return ++reads === 1
      ? response({ error: 'The local connection service is unavailable.' }, 503)
      : response(empty);
  });
  render(<FlipkartConnectionPanel mode="live" />);
  assert.match((await screen.findByRole('alert')).textContent ?? '', /local connection service/);
  assert.ok(screen.getByLabelText('Application ID').matches(':disabled'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection status' }));
  await screen.findByText(empty.message);
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(screen.getByLabelText('Application ID').matches(':disabled'), false);
  assert.equal(reads, 2);
});

test('unavailable secure storage leaves the connection form disabled with its explanation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response({
      ...empty,
      state: 'unavailable',
      message: 'Protected credential storage requires Windows.',
    }),
  );
  render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText('Protected credential storage requires Windows.');
  assert.ok(screen.getByLabelText('Application ID').matches(':disabled'));
  assert.ok(
    screen.getByRole('button', { name: 'Verify and save credentials' }).matches(':disabled'),
  );
});

test('leaving the connection screen aborts pending work and removes the secret from its input', async (t) => {
  let activeSignal: AbortSignal | undefined;
  let complete: (value: Response) => void = () => {};
  const pendingResponse = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/flipkart/connection') return response(empty);
      activeSignal = options?.signal ?? undefined;
      return pendingResponse;
    },
  );
  const view = render(<FlipkartConnectionPanel mode="live" />);
  await screen.findByText(empty.message);
  const { applicationSecret } = enterCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Verify and save credentials' }));
  await screen.findByRole('button', { name: 'Checking credentials…' });
  view.unmount();
  assert.equal(activeSignal?.aborted, true);
  assert.equal(applicationSecret.value, '');
  await act(async () => {
    complete(response(verified));
    await pendingResponse;
  });
});

test('leaving during the initial read aborts the status request', async (t) => {
  let activeSignal: AbortSignal | undefined;
  let complete: (value: Response) => void = () => {};
  const pendingResponse = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, options?: RequestInit) => {
      activeSignal = options?.signal ?? undefined;
      return pendingResponse;
    },
  );
  const view = render(<FlipkartConnectionPanel mode="live" />);
  await waitFor(() => assert.ok(activeSignal));
  view.rerender(<FlipkartConnectionPanel mode="demo" />);
  assert.equal(activeSignal?.aborted, true);
  await act(async () => {
    complete(response(verified));
    await pendingResponse;
  });
  assert.equal(screen.queryByText('API credentials verified'), null);
  assert.ok(screen.getByText('Sample mode does not accept credentials or contact Flipkart.'));
});
