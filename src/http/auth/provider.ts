/**
 * The provider-agnostic authentication port. The OIDC adapter (`./oidc-provider.js`)
 * implements it for real deployments; unit tests implement a fake. The rest of the auth
 * plugin depends only on this interface, so the concrete identity provider is a config-time
 * choice, not a code dependency.
 */

/** The authenticated identity handed to downstream handlers via `request.user`. */
export interface AuthenticatedUser {
  id: string;
  roles: string[];
}

/** An authorization redirect plus the per-login secrets to stash in the session. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The callback inputs the provider validates (state/nonce/PKCE) before returning a user. */
export interface CallbackParams {
  /** The full callback URL as received, query string included. */
  callbackUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface AuthProvider {
  /** Begin a login: build the IdP authorization URL and the state/nonce/PKCE to remember. */
  createAuthorizationRequest(): Promise<AuthorizationRequest>;
  /** Complete a login: validate the callback and return the authenticated identity. */
  exchangeCallback(params: CallbackParams): Promise<AuthenticatedUser>;
  /** Optional RP-initiated logout URL at the IdP. */
  endSessionUrl?(): string | undefined;
}
