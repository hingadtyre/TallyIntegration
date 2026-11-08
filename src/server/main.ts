import { startRuntime } from './runtime.js';

const mode = process.argv.includes('--demo') ? 'demo' : 'live';
try {
  const runtime = await startRuntime({ mode });
  console.log(`Stockbridge ${mode} dashboard: ${runtime.record.url}`);
  console.log('Marketplace publishing is disabled. Press Ctrl+C to stop.');
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
  process.exitCode = 1;
}
