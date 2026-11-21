import { error } from 'node:console';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  if (
    process.argv[2] === 'start' &&
    process.argv[3] === '--workspace' &&
    process.argv[5] === '--port'
  ) {
    process.env.STOCKBRIDGE_DATA_DIR = fileURLToPath(process.argv[4]);
    process.env.STOCKBRIDGE_DASHBOARD_PORT = process.argv[6];
  }
  const { runLauncher } = await import('../dist/src/desktop/launcher.js');
  await runLauncher(process.argv[2] ?? 'status', {
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    openBrowser: !process.argv.includes('--no-browser'),
  });
} catch (failure) {
  error(failure instanceof Error ? failure.message : 'Stockbridge could not complete the action.');
  process.exitCode = 1;
}
