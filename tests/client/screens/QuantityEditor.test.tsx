import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, fireEvent, waitFor } from '../../support/client-dom.js';
import { initialState } from '../../../src/server/seed.js';
import { QuantityEditor } from '../../../src/client/screens/QuantityEditor.js';
import type { Proposal } from '../../../src/shared/contracts.js';

const proposal: Proposal = {
  listingId: 'listing-1',
  quantity: 5,
  calculated: 5,
  edited: false,
  itemVersion: 1,
  listingVersion: 1,
  ruleVersion: 'flipkart-tyres-v1',
  createdAt: '2026-11-08T00:00:00.000Z',
  stale: false,
};

test('invalid quantities stay editable and never reach the save command', async () => {
  const state = initialState('demo', 'unused');
  let saves = 0;
  const { container } = render(
    <QuantityEditor
      listing={state.listings[0]}
      proposal={proposal}
      disabled={false}
      onDirty={() => {}}
      onSave={async () => {
        saves++;
        return { ok: true, value: state };
      }}
    />,
  );
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  for (const value of ['', '-1', '1.5', '9007199254740992']) {
    fireEvent.change(input, { target: { value } });
    // Submitting the form directly also verifies validation independently of browser constraints.
    fireEvent.submit(container.querySelector('form')!);
    assert.match((await screen.findByRole('alert')).textContent ?? '', /whole number of 0 or more/);
    assert.equal(input.value, value);
    assert.equal(saves, 0);
  }
});

test('a failed zero-draft save preserves the input and allows a successful retry', async () => {
  const state = initialState('demo', 'unused');
  const saved: number[] = [];
  const dirty: boolean[] = [];
  const { unmount } = render(
    <QuantityEditor
      listing={state.listings[0]}
      proposal={proposal}
      disabled={false}
      onDirty={(id, value) => {
        assert.equal(id, 'listing-1');
        dirty.push(value);
      }}
      onSave={async (quantity) => {
        saved.push(quantity);
        return saved.length === 1
          ? { ok: false, error: 'The source changed. Check the draft again.' }
          : { ok: true, value: state };
      }}
    />,
  );

  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
  assert.equal(dirty.at(-1), true);
  fireEvent.click(screen.getByRole('button', { name: /Save draft quantity/ }));
  assert.match((await screen.findByRole('alert')).textContent ?? '', /source changed/);
  assert.equal((screen.getByRole('spinbutton') as HTMLInputElement).value, '0');
  fireEvent.click(screen.getByRole('button', { name: /Save draft quantity/ }));
  await waitFor(() => assert.deepEqual(saved, [0, 0]));
  assert.equal(screen.queryByRole('alert'), null);
  unmount();
  assert.equal(dirty.at(-1), false);
});

test('stale saved edits remain visible and must be saved again before review', () => {
  const state = initialState('demo', 'unused');
  render(
    <QuantityEditor
      listing={state.listings[0]}
      proposal={{ ...proposal, quantity: 0, edited: true, stale: true }}
      disabled={false}
      onDirty={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );

  assert.equal((screen.getByRole('spinbutton') as HTMLInputElement).value, '0');
  assert.ok(screen.getByText('Save again to review'));
  assert.equal(
    (screen.getByRole('button', { name: /Save draft quantity/ }) as HTMLButtonElement).disabled,
    false,
  );
});
