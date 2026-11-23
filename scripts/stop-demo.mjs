import { error } from 'node:console';
import { resolve } from 'node:path';
import process from 'node:process';

try {
  if (!process.version.startsWith('v24.')) throw new Error('Use Node.js 24 to stop the demo.');
  // Use the checkout's controller even when the running demo was built earlier.
  const { stopDemo } = await import('../src/desktop/runtime-control.ts');
  const directory = process.env.STOCKBRIDGE_DATA_DIR ?? resolve(import.meta.dirname, '../.data');
  await stopDemo(directory);
} catch (failure) {
  error(failure instanceof Error ? failure.message : 'Stockbridge could not stop the demo.');
  process.exitCode = 1;
}
