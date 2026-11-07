import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Activity } from '../shared/contracts.js';

interface ErrorDetails {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: ErrorDetails;
}

/** Do not persist request bodies, XML, credentials or arbitrary thrown objects. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/<[^>]*>[\s\S]*/g, 'XML payload omitted')
    .replace(/[[{][\s\S]*/g, 'structured payload omitted')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        if (url.search) url.search = '?[redacted]';
        return url.toString();
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(
      /\b(authorization|password|passwd|secret|client_secret|app_secret|access_token|refresh_token|token|api_key)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, 2000);
}

function describeError(error: unknown, depth = 0): ErrorDetails {
  if (!(error instanceof Error))
    return { name: 'NonError', message: 'A non-Error value was thrown; its content was omitted.' };
  const code = (error as NodeJS.ErrnoException).code;
  const details: ErrorDetails = {
    name: redactDiagnosticText(error.name),
    message: redactDiagnosticText(error.message).slice(0, 500),
  };
  if (typeof code === 'string') details.code = redactDiagnosticText(code);
  if (error.stack) {
    // The first stack line repeats the message. Keep call sites separately.
    details.stack = error.stack
      .split('\n')
      .slice(1, 9)
      .map((line) => {
        // V8's frame labels use angle/square brackets; they are code labels, not payloads.
        const frame = line
          .replaceAll('<anonymous>', 'anonymous')
          .replace(/\[as ([^\]]+)\]/g, '(as $1)');
        return redactDiagnosticText(frame);
      })
      .join('\n');
  }
  if (error.cause !== undefined && depth < 2) details.cause = describeError(error.cause, depth + 1);
  return details;
}

export class Diagnostics {
  constructor(readonly file: string) {}

  write(
    operation: string,
    message: string,
    level: Activity['level'] = 'info',
    requestId?: string,
  ): void {
    this.append({
      operation: redactDiagnosticText(operation),
      message: redactDiagnosticText(message),
      level,
      requestId,
    });
  }

  error(operation: string, error: unknown, requestId?: string): void {
    this.append({
      operation: redactDiagnosticText(operation),
      level: 'error',
      requestId,
      error: describeError(error),
    });
  }

  read(): string {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
  }

  private append(fields: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > 10_000_000)
        renameSync(this.file, `${this.file}.previous`);
      appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n');
    } catch (error) {
      // A full/unwritable log disk must not turn the error handler into another failed request.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      console.error('Could not write the diagnostic log.', code ?? 'Unknown filesystem error');
    }
  }
}
