import { startRuntime } from './runtime.js';
import { WorkspaceInUseError } from './workspace-in-use.js';

const mode = process.argv.includes('--demo') ? 'demo' : 'live';
try {
  const runtime = await startRuntime({ mode });
  console.log(`Stockbridge ${mode} dashboard: ${runtime.record.url}`);
  console.log(
    mode === 'demo'
      ? 'Sample workspace. Inventory and marketplace updates are simulated. To stop, press Ctrl+C here or run npm run demo:stop from another terminal in the project folder.'
      : 'Live workspace. Publishing sends verified stock updates to the reviewed listings. Press Ctrl+C to stop.',
  );
  const stop = () => {
    void runtime.stop().catch((error: unknown) => {
      console.error(
        'Stockbridge could not finish shutting down:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(
    'Stockbridge could not start:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = error instanceof WorkspaceInUseError ? WorkspaceInUseError.exitCode : 1;
}
