import { spawnSync } from 'node:child_process';
import { error } from 'node:console';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'tests');
const sources = readdirSync(testRoot, { recursive: true })
  .filter((file) => /\.test\.tsx?$/.test(file))
  .sort();
const requested = process.argv.slice(2).map((file) => resolve(root, file));
const matches = (file, selected) => {
  const absolute = resolve(testRoot, file);
  return absolute === selected || absolute.startsWith(selected + sep);
};
const missing = requested.filter((selected) => !sources.some((file) => matches(file, selected)));

if (!sources.length || missing.length) {
  error('No test source files found for:', missing.length ? missing.join(', ') : testRoot);
  process.exitCode = 1;
} else {
  // Select from source files so renamed/deleted tests left in dist cannot run again.
  const compiled = sources
    .filter((file) => !requested.length || requested.some((selected) => matches(file, selected)))
    .map((file) => join(root, 'dist', 'tests', file.replace(/\.tsx?$/, '.js')));
  const result = spawnSync(process.execPath, ['--test', ...compiled], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
