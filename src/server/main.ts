import { resolve } from 'node:path';
import { TallyClient } from '../adapters/tally.js';
import { Diagnostics } from './diagnostics.js';
import { createApp } from './http.js';
import { InventoryService } from './service.js';
import { Store } from './store.js';

const mode = process.argv.includes('--demo') ? 'demo' : 'live';
const store = new Store(resolve('.data', `${mode}.sqlite`), mode);
const diagnostics = new Diagnostics(resolve('.data', `${mode}.diagnostics.ndjson`));
const service = new InventoryService(store, {
  diagnostics,
  createTallyReader: (endpoint) => new TallyClient(endpoint),
});
const app = createApp(service);
const port = mode === 'demo' ? 4311 : 4310;

app.listen(port, '127.0.0.1', () => {
  service.start();
  service.log('startup', `${mode} dashboard started; marketplace publishing disabled.`);
  console.log(`Stockbridge ${mode} dashboard: http://127.0.0.1:${port}`);
  console.log('Marketplace publishing is disabled. Press Ctrl+C to stop.');
});

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  service.stop();
  app.close(() => {
    void service.idle().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('error', (error) => {
  diagnostics.error('http-server', error);
  console.error(error.message);
  service.stop();
  store.close();
  process.exitCode = 1;
});
