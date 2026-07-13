import * as client from 'openid-client';
import type { Config } from '../../config/schema.js';
import { createFailure } from '../../failure-model/index.js';
import type {
  AuthProvider,
  AuthenticatedUser,
  AuthorizationRequest,
  CallbackParams,
} from './provider.js';

/**
 * The concrete OIDC/OAuth2 authorization-code adapter (with PKCE). Works against any OIDC
 * issuer configured via `OIDC_*`. Discovery is lazy and cached. This is built only in real
 * deployments; unit tests inject a fake AuthProvider and never reach the network.
 */
export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

/** Validate and extract the OIDC settings, failing closed if any are missing. */
export function oidcSettingsFromConfig(config: Config): OidcSettings {
  const missing: string[] = [];
  if (!config.OIDC_ISSUER_URL) missing.push('OIDC_ISSUER_URL');
  if (!config.OIDC_CLIENT_ID) missing.push('OIDC_CLIENT_ID');
  if (!config.OIDC_CLIENT_SECRET) missing.push('OIDC_CLIENT_SECRET');
  if (!config.OIDC_REDIRECT_URI) missing.push('OIDC_REDIRECT_URI');
  if (missing.length > 0 || !config.OIDC_ISSUER_URL) {
    // Boot-time misconfiguration; the caller surfaces the code. (Names go to its log line.)
    throw createFailure('CONFIG_MISSING_OR_INVALID', {
      processingState: 'paused',
      context: { environment: config.NODE_ENV },
    });
  }
  return {
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID ?? '',
    clientSecret: config.OIDC_CLIENT_SECRET ?? '',
    redirectUri: config.OIDC_REDIRECT_URI ?? '',
    scopes: config.OIDC_SCOPES,
  };
}

/**
 * Build the URL handed to the token exchange: the origin + path come from the trusted,
 * configured `OIDC_REDIRECT_URI`; only the query string (code, state, iss, ...) is taken from
 * the received request. This stops a spoofed/mis-forwarded `Host` or proxy header from
 * changing the `redirect_uri` openid-client derives for the token request.
 */
export function trustedCallbackUrl(
  configuredRedirectUri: string,
  receivedCallbackUrl: string,
): URL {
  const trusted = new URL(configuredRedirectUri);
  trusted.search = new URL(receivedCallbackUrl).search;
  return trusted;
}

function extractRoles(claims: Record<string, unknown>): string[] {
  const raw = claims.roles ?? claims.groups;
  if (Array.isArray(raw)) {
    return raw.filter((r): r is string => typeof r === 'string');
  }
  return [];
}

export class OidcAuthProvider implements AuthProvider {
  private configPromise?: Promise<client.Configuration>;

  constructor(private readonly settings: OidcSettings) {}

  private discover(): Promise<client.Configuration> {
    this.configPromise ??= client.discovery(
      new URL(this.settings.issuerUrl),
      this.settings.clientId,
      this.settings.clientSecret,
    );
    return this.configPromise;
  }

  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    const config = await this.discover();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.redirectUri,
      scope: this.settings.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state, nonce, codeVerifier };
  }

  async exchangeCallback(params: CallbackParams): Promise<AuthenticatedUser> {
    const config = await this.discover();
    // Throws if state/nonce/PKCE do not validate — the /auth/callback route maps that to a
    // refused login rather than leaking the reason. The callback origin/path is the trusted
    // configured redirect URI, never derived from request Host/proxy headers.
    const tokens = await client.authorizationCodeGrant(
      config,
      trustedCallbackUrl(this.settings.redirectUri, params.callbackUrl),
      {
        expectedState: params.state,
        expectedNonce: params.nonce,
        pkceCodeVerifier: params.codeVerifier,
      },
    );
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error('OIDC callback returned no subject claim');
    }
    return { id: claims.sub, roles: extractRoles(claims) };
  }

  /**
   * The IdP logout (RP-initiated logout) URL. Sending the browser here — not just destroying the
   * local session — is what clears the IdP's own SSO cookie, so the user actually has to sign in
   * again. Built from config: Auth0's logout endpoint (`{issuer}v2/logout`) with `client_id` and a
   * `returnTo` derived from the redirect URI's origin (which must be in Auth0's Allowed Logout URLs).
   * Returns undefined if the OIDC settings are incomplete, in which case logout falls back to a
   * local-session-only sign-out.
   */
  endSessionUrl(): string | undefined {
    const { issuerUrl, clientId, redirectUri } = this.settings;
    if (!issuerUrl || !clientId || !redirectUri) return undefined;
    try {
      const base = issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`;
      const url = new URL('v2/logout', base);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('returnTo', `${new URL(redirectUri).origin}/`);
      return url.toString();
    } catch {
      return undefined;
    }
  }
}

export function oidcProviderFromConfig(config: Config): OidcAuthProvider {
  return new OidcAuthProvider(oidcSettingsFromConfig(config));
}
