import {
  FlipkartAuthenticationError,
  FlipkartClient,
  validateFlipkartCredentials,
  type FlipkartAccessToken,
  type FlipkartCredentials,
} from '../adapters/flipkart.js';
import type { FlipkartConnectionStatus } from '../shared/contracts.js';
import {
  FlipkartCredentialError,
  ProtectedFlipkartCredentialStore,
  type FlipkartCredentialStore,
} from './flipkart-credentials.js';

export class FlipkartConnectionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface FlipkartConnectionDependencies {
  credentialStore?: FlipkartCredentialStore;
  client?: Pick<FlipkartClient, 'createAccessToken'>;
  now?: () => number;
}

function emptyStatus(
  message = 'No seller-owned Flipkart application is connected.',
): FlipkartConnectionStatus {
  return {
    state: 'not-configured',
    checkedAt: null,
    expiresAt: null,
    applicationIdHint: null,
    message,
  };
}

function publicFailure(error: unknown): FlipkartConnectionError {
  if (error instanceof FlipkartConnectionError) return error;
  if (error instanceof FlipkartAuthenticationError || error instanceof FlipkartCredentialError) {
    return new FlipkartConnectionError(error.message);
  }
  return new FlipkartConnectionError(
    'The Flipkart connection could not be completed. Try again or reconnect the seller-owned application.',
    503,
  );
}

/** Authentication is independent of inventory data; obtaining a token never enables publishing. */
export class FlipkartConnection {
  private readonly credentials: FlipkartCredentialStore;
  private readonly client: Pick<FlipkartClient, 'createAccessToken'>;
  private readonly now: () => number;
  private token: FlipkartAccessToken | null = null;
  private current = emptyStatus();
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    dataDirectory: string,
    private readonly mode: 'live' | 'demo',
    dependencies: FlipkartConnectionDependencies = {},
  ) {
    this.credentials =
      dependencies.credentialStore ?? new ProtectedFlipkartCredentialStore(dataDirectory);
    this.now = dependencies.now ?? Date.now;
    this.client = dependencies.client ?? new FlipkartClient({ now: this.now });
  }

  private unavailable(): FlipkartConnectionStatus | null {
    if (this.mode === 'demo')
      return {
        ...emptyStatus('Flipkart credentials cannot be connected in sample mode.'),
        state: 'unavailable',
      };
    if (!this.credentials.available)
      return {
        ...emptyStatus(
          'Seller-owned Flipkart access requires protected credential storage on Windows.',
        ),
        state: 'unavailable',
      };
    return null;
  }

  private requireAvailable(): void {
    const unavailable = this.unavailable();
    if (unavailable) throw new FlipkartConnectionError(unavailable.message, 409);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      if (this.stopped)
        throw new FlipkartConnectionError(
          'Stockbridge is stopping. Start it again before connecting Flipkart.',
          503,
        );
      return operation();
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private verified(
    credentials: FlipkartCredentials,
    token: FlipkartAccessToken,
  ): FlipkartConnectionStatus {
    this.token = token;
    this.current = {
      state: 'verified',
      checkedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(token.expiresAt).toISOString(),
      applicationIdHint: `***${credentials.applicationId.slice(-4)}`,
      message:
        'API credentials verified. Seller identity, listings and stock synchronization are not yet verified.',
    };
    return { ...this.current };
  }

  status(): Promise<FlipkartConnectionStatus> {
    return this.serial(async () => {
      const unavailable = this.unavailable();
      if (unavailable) return unavailable;
      try {
        const credentials = await this.credentials.read();
        if (!credentials) {
          this.token = null;
          this.current = emptyStatus();
        } else if (!this.token || this.token.expiresAt <= this.now()) {
          this.token = null;
          const hint = `***${credentials.applicationId.slice(-4)}`;
          const preserveFailure =
            this.current.state === 'needs-attention' && this.current.applicationIdHint === hint;
          this.current = {
            ...this.current,
            state: 'needs-attention',
            applicationIdHint: hint,
            expiresAt: null,
            message: preserveFailure
              ? this.current.message
              : 'Credentials are saved on this computer. Check the connection to obtain current API authorization.',
          };
        }
        return { ...this.current };
      } catch {
        this.token = null;
        this.current = {
          ...emptyStatus(
            'Saved credentials could not be read. Reconnect using the intended Windows account.',
          ),
          state: 'needs-attention',
        };
        return { ...this.current };
      }
    });
  }

  connect(input: unknown): Promise<FlipkartConnectionStatus> {
    return this.serial(async () => {
      this.requireAvailable();
      try {
        const credentials = validateFlipkartCredentials(input);
        const token = await this.client.createAccessToken(credentials);
        // A rejected token or failed protected write must not replace the working connection.
        await this.credentials.write(credentials);
        return this.verified(credentials, token);
      } catch (error) {
        throw publicFailure(error);
      }
    });
  }

  /** Preserve a seller's existing credentials while registration approval is still pending. */
  save(input: unknown): Promise<FlipkartConnectionStatus> {
    return this.serial(async () => {
      this.requireAvailable();
      try {
        const credentials = validateFlipkartCredentials(input);
        await this.credentials.write(credentials);
        // A saved replacement is unverified and must never reuse the preceding account's token.
        this.token = null;
        this.current = {
          state: 'needs-attention',
          applicationIdHint: `***${credentials.applicationId.slice(-4)}`,
          checkedAt: null,
          expiresAt: null,
          message:
            'Credentials saved securely without contacting Flipkart. API access is unverified. If approval is pending, use Check saved access after Flipkart approves the application.',
        };
        return { ...this.current };
      } catch (error) {
        throw publicFailure(error);
      }
    });
  }

  private async authorize(): Promise<FlipkartAccessToken> {
    this.requireAvailable();
    try {
      const credentials = await this.credentials.read();
      if (!credentials) {
        this.token = null;
        this.current = emptyStatus();
        throw new FlipkartConnectionError(
          'Connect a seller-owned Flipkart application first.',
          409,
        );
      }
      const token = await this.client.createAccessToken(credentials);
      this.verified(credentials, token);
      return token;
    } catch (error) {
      this.token = null;
      const failure = publicFailure(error);
      this.current = {
        ...this.current,
        state: 'needs-attention',
        checkedAt: new Date(this.now()).toISOString(),
        expiresAt: null,
        message: failure.message,
      };
      throw failure;
    }
  }

  check(): Promise<FlipkartConnectionStatus> {
    return this.serial(async () => {
      await this.authorize();
      return { ...this.current };
    });
  }

  /** Backend-only access. Never expose this result through a dashboard API or log. */
  getAccessToken(): Promise<string> {
    return this.serial(async () => {
      this.requireAvailable();
      // Renew ahead of expiry using the token response, rather than a fixed platform lifetime.
      if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
      return (await this.authorize()).value;
    });
  }

  disconnect(): Promise<FlipkartConnectionStatus> {
    return this.serial(async () => {
      this.requireAvailable();
      this.token = null;
      try {
        await this.credentials.remove();
        this.current = emptyStatus(
          'Saved Flipkart credentials were removed from this installation. No marketplace stock was changed.',
        );
        return { ...this.current };
      } catch (error) {
        const failure = publicFailure(error);
        this.current = {
          ...this.current,
          state: 'needs-attention',
          expiresAt: null,
          message: failure.message,
        };
        throw failure;
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.token = null;
  }

  async idle(): Promise<void> {
    await this.pending;
    if (this.stopped) this.token = null;
  }
}
