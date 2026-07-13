import { describe, expect, it } from 'vitest';
import { OidcAuthProvider } from '../../src/http/index.js';

/**
 * `endSessionUrl()` builds the IdP (Auth0) RP-initiated logout URL from config, synchronously (no
 * discovery). Sending the browser here is what clears the IdP SSO cookie so Sign-out truly signs the
 * user out — see docs + the logout handler's `{ next }` branch.
 */
describe('OidcAuthProvider.endSessionUrl', () => {
  const settings = {
    issuerUrl: 'https://dev-tenant.us.auth0.com/',
    clientId: 'client-123',
    clientSecret: 'secret',
    redirectUri: 'https://console-dev.up.railway.app/auth/callback',
    scopes: 'openid profile email',
  };

  it('derives the Auth0 logout URL with client_id and a returnTo from the redirect origin', () => {
    const url = new OidcAuthProvider(settings).endSessionUrl();
    expect(url).toBeDefined();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe('https://dev-tenant.us.auth0.com');
    expect(parsed.pathname).toBe('/v2/logout');
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    // returnTo is the redirect URI's ORIGIN + '/', which must be an Auth0 Allowed Logout URL.
    expect(parsed.searchParams.get('returnTo')).toBe('https://console-dev.up.railway.app/');
  });

  it('tolerates an issuer URL without a trailing slash', () => {
    const url = new OidcAuthProvider({
      ...settings,
      issuerUrl: 'https://dev-tenant.us.auth0.com',
    }).endSessionUrl();
    expect(new URL(url!).pathname).toBe('/v2/logout');
  });

  it('returns undefined when settings are incomplete', () => {
    expect(new OidcAuthProvider({ ...settings, clientId: '' }).endSessionUrl()).toBeUndefined();
    expect(new OidcAuthProvider({ ...settings, redirectUri: '' }).endSessionUrl()).toBeUndefined();
  });
});
