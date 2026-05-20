import { logger } from '../logger.js';
import { YouTubeError } from './errors.js';

/**
 * YouTube OAuth — exchange the long-lived refresh token (from env) for a
 * short-lived access token, cached in memory until just before expiry.
 *
 * Token endpoint: https://oauth2.googleapis.com/token
 * Refresh flow:   grant_type=refresh_token
 *
 * The refresh token comes from the bootstrap OAuth Playground flow (see
 * scripts/verify-youtube-oauth.ts). DREK never mints the refresh token
 * itself — that's a manual one-time human-in-the-loop step.
 *
 * Cache: a single access token + expiry timestamp per provider instance.
 * Multiple concurrent callers asking for the same token are deduplicated
 * via the inFlight promise so we never burn two refresh round-trips for
 * the same expiry boundary.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Refresh the cached access token this many ms before it actually expires.
 *  Google access tokens last ~3600s; refreshing at -120s gives us a buffer
 *  for slow networks without making us refresh every call. */
const REFRESH_LEAD_MS = 120_000;

interface CachedToken {
  accessToken: string;
  /** Epoch ms when this token expires (server-reported, NOT clock-adjusted). */
  expiresAt: number;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export class YouTubeOAuth {
  private readonly creds: OAuthCredentials;
  private readonly timeoutMs: number;
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(creds: OAuthCredentials, opts: { timeoutMs?: number } = {}) {
    this.creds = creds;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Return a valid access token, refreshing if the cached one is missing
   *  or within REFRESH_LEAD_MS of expiry. Safe to call concurrently — the
   *  in-flight promise deduplicates parallel refresh requests. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - REFRESH_LEAD_MS > now) {
      return this.cached.accessToken;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Drop the cached token. Test-only + the client uses this after a 401
   *  in case the refresh-token rotation kicked in mid-session. */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
      grant_type: 'refresh_token',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let res: Response;
    try {
      res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err as Error & { name?: string };
      if (cause.name === 'AbortError') {
        throw new YouTubeError(
          'TIMEOUT',
          TOKEN_ENDPOINT,
          `token refresh exceeded ${this.timeoutMs}ms`,
        );
      }
      throw new YouTubeError(
        'UNREACHABLE',
        TOKEN_ENDPOINT,
        cause.message || 'token refresh fetch failed',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Auth failures are terminal — never retry, never log the secret.
      let detail: unknown = null;
      try {
        detail = (await res.json()) as unknown;
      } catch {
        // ignore body parse failure
      }
      throw new YouTubeError(
        'AUTH_FAILED',
        TOKEN_ENDPOINT,
        `token refresh failed: HTTP ${res.status}`,
        { status: res.status, detail },
      );
    }

    let parsed: AccessTokenResponse;
    try {
      parsed = (await res.json()) as AccessTokenResponse;
    } catch (err) {
      throw new YouTubeError(
        'INVALID_RESPONSE',
        TOKEN_ENDPOINT,
        `token endpoint returned non-JSON: ${(err as Error).message}`,
        { status: res.status },
      );
    }

    if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
      throw new YouTubeError(
        'INVALID_RESPONSE',
        TOKEN_ENDPOINT,
        'token response missing access_token or expires_in',
        { status: res.status },
      );
    }

    const expiresAt = Date.now() + parsed.expires_in * 1000;
    this.cached = { accessToken: parsed.access_token, expiresAt };
    logger.debug(
      { expiresInSeconds: parsed.expires_in },
      'youtube-oauth: refreshed access token',
    );
    return parsed.access_token;
  }
}
