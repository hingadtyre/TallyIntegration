import console from 'node:console';
import process from 'node:process';
import { inspectPilotBackup, restorePilotBackup } from '../dist/src/server/restore.js';

const usage = [
  'Offline pilot restore. Marketplace publishing remains disabled.',
  'Inspect first:',
  '  node scripts/restore-pilot.mjs inspect --backup <absolute.sqlite> --mode live|demo',
  'Replace only after inspecting:',
  '  node scripts/restore-pilot.mjs restore --backup <absolute.sqlite> --mode live|demo --data-dir <absolute folder> --expected-sha256 <digest from inspect> --confirm-replace',
].join('\n');

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') {
    console.log(usage);
  } else {
    if (command !== 'inspect' && command !== 'restore') throw new Error(usage);
    const values = new Map();
    const allowed =
      command === 'inspect'
        ? new Set(['--backup', '--mode'])
        : new Set(['--backup', '--mode', '--data-dir', '--expected-sha256', '--confirm-replace']);
    while (args.length) {
      const key = args.shift();
      if (!allowed.has(key) || values.has(key))
        throw new Error(`Unknown or repeated argument: ${key}.\n${usage}`);
      if (key === '--confirm-replace') values.set(key, true);
      else {
        const value = args.shift();
        if (!value || value.startsWith('--'))
          throw new Error(`Provide a value for ${key}.\n${usage}`);
        values.set(key, value);
      }
    }
    const mode = values.get('--mode');
    const backupFile = values.get('--backup');
    if ((mode !== 'live' && mode !== 'demo') || !backupFile) throw new Error(usage);
    if (command === 'inspect') {
      console.log(JSON.stringify(inspectPilotBackup(backupFile, mode), null, 2));
      console.log(
        'Preview only. Keep this SHA-256 for explicit replacement. Existing local settings will be preserved; restored stock must be refreshed.',
      );
    } else {
      const dataDirectory = values.get('--data-dir');
      const expectedSha256 = values.get('--expected-sha256');
      if (!dataDirectory || !expectedSha256 || values.get('--confirm-replace') !== true)
        throw new Error(usage);
      console.log(
        JSON.stringify(
          await restorePilotBackup({
            backupFile,
            mode,
            dataDirectory,
            expectedSha256,
            confirmReplace: true,
          }),
          null,
          2,
        ),
      );
      console.log(
        'Offline pilot restore completed. Start Stockbridge, refresh Tally and review the restored records. Marketplace publishing remains disabled.',
      );
    }
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Pilot restore failed. Contact support before changing database files.',
  );
  process.exitCode = 1;
}
