import { error } from 'node:console';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  const { runLauncher } = await import('../dist/src/desktop/launcher.js');
  await runLauncher(process.argv[2] ?? 'status', {
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    openBrowser: !process.argv.includes('--no-browser'),
  });
} catch (failure) {
  error(failure instanceof Error ? failure.message : 'Stockbridge could not complete the action.');
  process.exitCode = 1;
}
