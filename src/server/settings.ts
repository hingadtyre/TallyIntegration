import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateTallyUrl } from '../adapters/tally.js';
import type { Settings } from '../shared/contracts.js';
import { recordActivity } from './activity.js';
import type { Store } from './store.js';
import { InputError, requireText, requireWholeNumber } from './validation.js';

function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new InputError('Settings are required.');
  const input = value as Record<string, unknown>;
  let tallyUrl: string;
  try {
    tallyUrl = validateTallyUrl(requireText(input.tallyUrl, 'Tally address'));
  } catch {
    throw new InputError(
      'Tally needs a local HTTP or HTTPS address, such as http://127.0.0.1:9000/.',
    );
  }
  const settings: Settings = {
    tallyUrl,
    tallySeconds: requireWholeNumber(input.tallySeconds, 'Tally interval', 5, 86400),
    marketplaceSeconds: requireWholeNumber(
      input.marketplaceSeconds,
      'Marketplace interval',
      30,
      86400,
    ),
    catalogSeconds: requireWholeNumber(input.catalogSeconds, 'Catalog interval', 60, 86400),
    backupFolder: requireText(input.backupFolder, 'Backup folder'),
  };
  if (!isAbsolute(settings.backupFolder))
    throw new InputError('Use an absolute backup folder path.');
  const probe = join(settings.backupFolder, `.stockbridge-write-check-${randomUUID()}`);
  try {
    mkdirSync(settings.backupFolder, { recursive: true });
    writeFileSync(probe, 'write check', { flag: 'wx' });
    unlinkSync(probe);
  } catch {
    throw new InputError(
      'The backup folder must be a writable directory. Previous settings were retained.',
    );
  }
  return settings;
}

export function saveSettings(store: Store, input: unknown): void {
  const settings = validateSettings(input);
  store.update((state) => {
    if (validateTallyUrl(state.settings.tallyUrl) !== settings.tallyUrl) {
      state.connection.tally = 'not-checked';
      state.connection.message = 'Tally address changed. Refresh required.';
      state.proposals.forEach((draft) => {
        draft.itemVersion = -1;
      });
    }
    state.settings = settings;
    recordActivity(
      state,
      'settings-saved',
      'Settings saved. The next Tally poll uses the new interval; no restart needed. Marketplace polling is pending API setup.',
    );
  });
}
