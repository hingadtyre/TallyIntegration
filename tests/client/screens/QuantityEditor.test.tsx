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

test('an oversized saved draft shows the editable quantity and its publication limit', () => {
  const state = initialState('demo', 'unused');
  render(
    <QuantityEditor
      listing={state.listings[0]}
      proposal={{ ...proposal, quantity: 5100, edited: true, stale: true }}
      disabled={false}
      onDirty={() => {}}
      onSave={async () => ({ ok: true as const, value: state })}
    />,
  );
  const field = screen.getByRole<HTMLInputElement>('spinbutton');
  assert.equal(field.value, '5100');
  assert.ok(screen.getByText(/accepts up to 5000/i));
  fireEvent.change(field, { target: { value: '5000' } });
  assert.equal(field.value, '5000');
  assert.ok(screen.getByText('Unsaved draft'));
});

test('a pending order calculation shows its automatic retry and then the verified proposal', () => {
  const state = initialState('demo', 'unused');
  const props = {
    disabled: false,
    onDirty: () => {},
    onSave: async () => ({ ok: true as const, value: state }),
  };
  const pending = { ...state.listings[0], orderProposalPending: true };
  const { rerender } = render(<QuantityEditor {...props} listing={pending} />);
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  assert.equal(input.value, '');
  assert.ok(screen.getByText('Checking orders and Tally stock…'));
  rerender(
    <QuantityEditor {...props} listing={{ ...pending, proposalIssue: 'Tally is offline.' }} />,
  );
  assert.ok(screen.getByText('Tally is offline. Stockbridge will check again automatically.'));
  rerender(
    <QuantityEditor
      {...props}
      listing={state.listings[0]}
      proposal={{ ...proposal, quantity: 1, calculated: 1 }}
    />,
  );
  assert.equal(input.value, '1');
  assert.ok(screen.getByText('Calculated draft'));
});

test('a seller draft shows its publication or stale status alongside the pending order check', () => {
  const state = initialState('demo', 'unused');
  const props = {
    disabled: false,
    onDirty: () => {},
    onSave: async () => ({ ok: true as const, value: state }),
  };
  const pending = {
    ...state.listings[0],
    orderProposalPending: true,
    proposalIssue: 'Tally is offline.',
  };
  const draft = { ...proposal, quantity: 0, edited: true };
  const { rerender } = render(<QuantityEditor {...props} listing={pending} proposal={draft} />);
  const retry = 'Tally is offline. Stockbridge will check again automatically.';
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  assert.equal(input.value, '0');
  assert.ok(screen.getByText('Publishing pauses Tally sync'));
  assert.ok(
    input.getAttribute('aria-describedby')?.split(' ').includes(screen.getByText(retry).id),
  );
  rerender(<QuantityEditor {...props} listing={pending} proposal={{ ...draft, stale: true }} />);
  assert.ok(screen.getByText('Save again to review'));
  assert.ok(screen.getByText(retry));
  fireEvent.change(input, { target: { value: '2' } });
  assert.ok(screen.getByText('Unsaved draft'));
  assert.ok(screen.getByText(retry));
  rerender(<QuantityEditor {...props} listing={state.listings[0]} proposal={draft} />);
  assert.equal(input.value, '2');
  assert.equal(screen.queryByText(retry), null);
});

test('a changed mapping preserves the typed quantity but requires a new edit before saving', () => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  const editor = (version: number) => (
    <QuantityEditor
      listing={{ ...listing, version }}
      disabled={false}
      onDirty={() => {}}
      onSave={async () => {
        throw new Error('A stale edit must not save');
      }}
    />
  );
  const { rerender } = render(editor(listing.version));
  const input = screen.getByRole<HTMLInputElement>('spinbutton');
  fireEvent.change(input, { target: { value: '2' } });
  rerender(editor(listing.version + 1));
  assert.equal(input.value, '2');
  assert.ok(screen.getByText(/check the current mapping/i));
  assert.equal(
    screen.getByRole<HTMLButtonElement>('button', { name: /Save draft/ }).disabled,
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: /Discard edit/ }));
  fireEvent.change(input, { target: { value: '1' } });
  assert.equal(
    screen.getByRole<HTMLButtonElement>('button', { name: /Save draft/ }).disabled,
    false,
  );
});

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
  fireEvent.change(input, { target: { value: '5001' } });
  fireEvent.submit(container.querySelector('form')!);
  assert.match((await screen.findByRole('alert')).textContent ?? '', /5000/);
  assert.equal(saves, 0);
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

test('explicitly retyping a calculated zero makes it a manual draft only after Save', async () => {
  const state = initialState('demo', 'unused');
  const calculatedZero = { ...proposal, quantity: 0, calculated: 0 };
  const saved: number[] = [];
  function editor(edited: boolean) {
    return (
      <QuantityEditor
        key={String(edited)}
        listing={state.listings[0]}
        proposal={{ ...calculatedZero, edited }}
        disabled={false}
        onDirty={() => {}}
        onSave={async (quantity) => {
          saved.push(quantity);
          return { ok: true, value: state };
        }}
      />
    );
  }
  const { rerender, container } = render(editor(false));
  const input = screen.getByRole('spinbutton');
  fireEvent.focus(input);
  assert.ok(screen.getByText('Calculated draft'));
  assert.equal(screen.queryByRole('button', { name: /Save draft/ }), null);
  fireEvent.submit(container.querySelector('form')!);
  assert.deepEqual(saved, []);
  fireEvent.input(input, { target: { value: '0' } });
  assert.deepEqual(saved, []);
  fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
  await waitFor(() => assert.deepEqual(saved, [0]));
  rerender(editor(true));
  assert.ok(screen.getByText('Publishing pauses Tally sync'));
  assert.equal(screen.queryByRole('button', { name: /Save draft/ }), null);
});

test('an unchanged calculated zero waits for its automatic update and cannot be submitted as a manual zero', () => {
  const state = initialState('demo', 'unused');
  let saves = 0;
  const { container } = render(
    <QuantityEditor
      listing={state.listings[0]}
      proposal={{ ...proposal, quantity: 0, calculated: 0, stale: true }}
      disabled={false}
      onDirty={() => {}}
      onSave={async () => {
        saves++;
        return { ok: true, value: state };
      }}
    />,
  );
  assert.ok(screen.getByText('Updating proposal…'));
  assert.equal(screen.queryByRole('button', { name: /Save draft/ }), null);
  fireEvent.submit(container.querySelector('form')!);
  assert.equal(saves, 0);
});

test('a refreshed proposal updates a clean input and preserves an unsaved manual quantity', async () => {
  const state = initialState('demo', 'unused');
  const saved: number[] = [];
  const editor = (draft: Proposal, issue?: string) => (
    <QuantityEditor
      listing={{ ...state.listings[0], proposalIssue: issue }}
      proposal={draft}
      disabled={false}
      onDirty={() => {}}
      onSave={async (quantity) => {
        saved.push(quantity);
        return { ok: true, value: state };
      }}
    />
  );
  const stale = { ...proposal, stale: true };
  const { rerender } = render(editor(stale, 'Check the stock balance in Tally.'));
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  assert.equal(input.value, '5');
  assert.ok(screen.getByText('Previous proposal. Check the stock balance in Tally.'));
  rerender(editor({ ...proposal, quantity: 4, itemVersion: 2 }));
  assert.equal(input.value, '4');
  assert.ok(screen.getByText('Calculated draft'));
  fireEvent.change(input, { target: { value: '2' } });
  rerender(editor({ ...proposal, quantity: 3, itemVersion: 3 }));
  assert.equal(input.value, '2');
  rerender(editor({ ...proposal, quantity: 2, itemVersion: 4 }));
  assert.ok(screen.getByText('Unsaved draft'));
  assert.deepEqual(saved, []);
  fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
  await waitFor(() => assert.deepEqual(saved, [2]));
});

test('retyping a calculated five can be saved explicitly or discarded to show the latest proposal', async () => {
  const state = initialState('demo', 'unused');
  const saved: number[] = [];
  const editor = (quantity: number) => (
    <QuantityEditor
      listing={state.listings[0]}
      proposal={{ ...proposal, quantity, calculated: quantity }}
      disabled={false}
      onDirty={() => {}}
      onSave={async (value) => {
        saved.push(value);
        return { ok: true, value: state };
      }}
    />
  );
  const { rerender } = render(editor(5));
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  fireEvent.focus(input);
  assert.equal(screen.queryByRole('button', { name: /Save draft/ }), null);
  fireEvent.input(input, { target: { value: '5' } });
  rerender(editor(4));
  assert.equal(input.value, '5');
  fireEvent.click(screen.getByRole('button', { name: /Discard edit/ }));
  assert.equal(input.value, '4');
  assert.deepEqual(saved, []);
  rerender(editor(5));
  fireEvent.input(input, { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
  await waitFor(() => assert.deepEqual(saved, [5]));
});
