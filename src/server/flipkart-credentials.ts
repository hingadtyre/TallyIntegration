import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { validateFlipkartCredentials, type FlipkartCredentials } from '../adapters/flipkart.js';

export class FlipkartCredentialError extends Error {}

export interface CredentialProtector {
  readonly available: boolean;
  protect(value: Buffer, context: Buffer): Promise<Buffer>;
  unprotect(value: Buffer, context: Buffer): Promise<Buffer>;
}

export interface FlipkartCredentialStore {
  readonly available: boolean;
  read(): Promise<FlipkartCredentials | null>;
  write(credentials: FlipkartCredentials): Promise<void>;
  remove(): Promise<void>;
}

// The command is constant. Secret material is sent on stdin, never as arguments or environment.
const protectionScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $data = [Convert]::FromBase64String($request.data)
  $entropy = [Convert]::FromBase64String($request.context)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

export class WindowsCredentialProtector implements CredentialProtector {
  readonly available = process.platform === 'win32';

  protect(value: Buffer, context: Buffer): Promise<Buffer> {
    return this.run('protect', value, context);
  }

  unprotect(value: Buffer, context: Buffer): Promise<Buffer> {
    return this.run('unprotect', value, context);
  }

  private async run(
    operation: 'protect' | 'unprotect',
    value: Buffer,
    context: Buffer,
  ): Promise<Buffer> {
    if (!this.available) {
      throw new FlipkartCredentialError(
        'Saving Flipkart credentials requires this Windows installation.',
      );
    }
    return new Promise((accept, reject) => {
      const executable = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const child = spawn(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(protectionScript, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(
          new FlipkartCredentialError(
            'Windows could not protect or unlock the saved Flipkart credentials. Reconnect using the intended Windows account.',
          ),
        );
      };
      const timer = setTimeout(fail, 10_000);
      child.once('error', fail);
      child.stdin.once('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 128 * 1024) fail();
      });
      child.stderr.resume();
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output) || output.length % 4 !== 0) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(timer);
        accept(Buffer.from(output, 'base64'));
      });
      child.stdin.end(
        JSON.stringify({
          operation,
          data: value.toString('base64'),
          context: context.toString('base64'),
        }),
      );
    });
  }
}

/** Separate from SQLite and its portable backups; tied to this Windows user and workspace. */
export class ProtectedFlipkartCredentialStore implements FlipkartCredentialStore {
  readonly available: boolean;
  private readonly file: string;

  constructor(
    private readonly dataDirectory: string,
    private readonly protector: CredentialProtector = new WindowsCredentialProtector(),
  ) {
    if (!isAbsolute(dataDirectory) || /^\\\\|^\/\//u.test(dataDirectory)) {
      throw new FlipkartCredentialError(
        'Flipkart credentials require an absolute local data folder.',
      );
    }
    this.file = join(resolve(dataDirectory), 'flipkart-self-access.credentials');
    this.available = protector.available;
  }

  private requireProtection(): void {
    if (!this.available) {
      throw new FlipkartCredentialError(
        'Saving Flipkart credentials requires this Windows installation.',
      );
    }
  }

  private async context(): Promise<Buffer> {
    const directory = await realpath(this.dataDirectory);
    return Buffer.from(
      `Stockbridge/FlipkartSelfAccess/v1/${process.platform === 'win32' ? directory.toLowerCase() : directory}`,
      'utf8',
    );
  }

  private async existingFile(): Promise<boolean> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) {
        throw new FlipkartCredentialError(
          'The saved Flipkart credential file is invalid. Contact support.',
        );
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async read(): Promise<FlipkartCredentials | null> {
    this.requireProtection();
    try {
      if (!(await this.existingFile())) return null;
      const saved: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
      const record = saved as { version?: unknown; protected?: unknown };
      if (
        record.version !== 1 ||
        typeof record.protected !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.protected) ||
        record.protected.length % 4 !== 0
      )
        throw new Error();
      const plaintext = await this.protector.unprotect(
        Buffer.from(record.protected, 'base64'),
        await this.context(),
      );
      try {
        return validateFlipkartCredentials(JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new FlipkartCredentialError(
        'Saved Flipkart credentials could not be unlocked. Reconnect using the intended Windows account.',
      );
    }
  }

  async write(input: FlipkartCredentials): Promise<void> {
    this.requireProtection();
    const credentials = validateFlipkartCredentials(input);
    let temporary: string | undefined;
    try {
      await mkdir(this.dataDirectory, { recursive: true });
      await this.existingFile();
      const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
      let encrypted: Buffer;
      try {
        encrypted = await this.protector.protect(plaintext, await this.context());
      } finally {
        plaintext.fill(0);
      }
      temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, protected: encrypted.toString('base64') }),
        { flag: 'wx', mode: 0o600, flush: true },
      );
      await rename(temporary, this.file);
    } catch {
      throw new FlipkartCredentialError(
        'Flipkart credentials could not be saved securely. Previous credentials were retained.',
      );
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async remove(): Promise<void> {
    this.requireProtection();
    try {
      if (await this.existingFile()) await unlink(this.file);
    } catch {
      throw new FlipkartCredentialError(
        'Saved Flipkart credentials could not be removed. Contact support.',
      );
    }
  }
}
