import { error } from 'node:console';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  const [action = 'status', ...args] = process.argv.slice(2);
  const selection = args.filter((arg) => arg !== '--no-browser');
  if (selection.length) {
    if (
      action !== 'start' ||
      selection.length !== 4 ||
      selection[0] !== '--workspace' ||
      selection[2] !== '--port'
    ) {
      throw new Error(
        'Invalid launcher arguments. Use the supplied Stockbridge command or its desktop shortcut.',
      );
    }
    process.env.STOCKBRIDGE_DATA_DIR = fileURLToPath(selection[1]);
    process.env.STOCKBRIDGE_DASHBOARD_PORT = selection[3];
  }
  const { runLauncher } = await import('../dist/src/desktop/launcher.js');
  await runLauncher(action, {
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    openBrowser: !args.includes('--no-browser'),
  });
} catch (failure) {
  error(failure instanceof Error ? failure.message : 'Stockbridge could not complete the action.');
  process.exitCode = 1;
}
