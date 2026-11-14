export interface FlipkartCredentials {
  applicationId: string;
  applicationSecret: string;
}

export interface FlipkartAccessToken {
  value: string;
  expiresAt: number;
}

export class FlipkartAuthenticationError extends Error {}

const tokenUrl =
  'https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api,Default';
const maximumResponseBytes = 64 * 1024;

export function validateFlipkartCredentials(input: unknown): FlipkartCredentials {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FlipkartAuthenticationError('Enter the application ID and application secret.');
  }
  const values = input as Partial<FlipkartCredentials>;
  if (
    typeof values.applicationId !== 'string' ||
    !/^[^\s:]{1,256}$/u.test(values.applicationId) ||
    typeof values.applicationSecret !== 'string' ||
    !/^\S{1,2048}$/u.test(values.applicationSecret)
  ) {
    throw new FlipkartAuthenticationError(
      'Enter a valid application ID and application secret without whitespace.',
    );
  }
  return { applicationId: values.applicationId, applicationSecret: values.applicationSecret };
}

async function readTokenResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new FlipkartAuthenticationError(
      'Flipkart returned an unexpected authentication response.',
    );
  }
  const length = Number(response.headers.get('content-length'));
  if (length > maximumResponseBytes || !response.body) {
    throw new FlipkartAuthenticationError('Flipkart returned an invalid authentication response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel();
        throw new FlipkartAuthenticationError(
          'Flipkart returned an oversized authentication response.',
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new FlipkartAuthenticationError('Flipkart returned an invalid authentication response.');
  }
}

/** Only Flipkart's documented self-access token endpoint receives these credentials. */
export class FlipkartClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: { request?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new FlipkartAuthenticationError('Invalid Flipkart request timeout.');
    }
  }

  async createAccessToken(input: FlipkartCredentials): Promise<FlipkartAccessToken> {
    const credentials = validateFlipkartCredentials(input);
    try {
      const response = await this.request(tokenUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.applicationId}:${credentials.applicationSecret}`, 'utf8').toString('base64')}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          throw new FlipkartAuthenticationError(
            'Flipkart rejected these API credentials. Check the seller-owned application ID and secret.',
          );
        }
        if (response.status === 429) {
          throw new FlipkartAuthenticationError(
            'Flipkart is limiting authentication requests. Try again later.',
          );
        }
        throw new FlipkartAuthenticationError(
          'Flipkart authentication is temporarily unavailable. Try again later.',
        );
      }
      const value = await readTokenResponse(response);
      if (
        typeof value.access_token !== 'string' ||
        !/^[\x21-\x7e]{1,16384}$/u.test(value.access_token) ||
        typeof value.token_type !== 'string' ||
        value.token_type.toLowerCase() !== 'bearer' ||
        typeof value.expires_in !== 'number' ||
        !Number.isSafeInteger(value.expires_in) ||
        value.expires_in < 1 ||
        value.expires_in > 31_536_000 ||
        typeof value.scope !== 'string' ||
        !value.scope.split(/[\s,]+/u).includes('Seller_Api')
      ) {
        throw new FlipkartAuthenticationError(
          'Flipkart returned an invalid or insufficient API authorization.',
        );
      }
      return { value: value.access_token, expiresAt: this.now() + value.expires_in * 1000 };
    } catch (error) {
      if (error instanceof FlipkartAuthenticationError) throw error;
      // Fetch errors and response bodies can contain private request details; discard them.
      throw new FlipkartAuthenticationError(
        'Could not reach Flipkart authentication. Check the internet connection and try again.',
      );
    }
  }
}
