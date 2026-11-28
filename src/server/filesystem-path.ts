import { isAbsolute, parse } from 'node:path';

/** On Windows, a leading slash alone depends on the launcher's current drive. */
export function isFullyQualifiedPath(path: string, allowNetwork = false): boolean {
  return (
    !path.includes('\0') &&
    isAbsolute(path) &&
    (process.platform !== 'win32' || parse(path).root.length > 1) &&
    (allowNetwork || !path.replaceAll('\\', '/').startsWith('//'))
  );
}
