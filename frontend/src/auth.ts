const storageKey = 'datascout.access_token';
const expiryKey = 'datascout.expires_at';
const refreshKey = 'datascout.refresh_token';
const stateKey = 'datascout.oauth_state';
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const env = import.meta.env;
let exchangeStarted = false;
function authError(message: string) {
  sessionStorage.setItem('datascout.auth_error', message);
  window.dispatchEvent(
    new CustomEvent('datascout:auth-error', { detail: message }),
  );
}

export function getToken(): string | null {
  if (env.VITE_DEMO_MODE === 'true') return 'mock-access-token';
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (code && !exchangeStarted) {
    exchangeStarted = true;
    void exchangeCode(code, url.searchParams.get('state'));
  }
  return localStorage.getItem(storageKey);
}

async function exchangeCode(code: string, state: string | null) {
  const verifier = sessionStorage.getItem('datascout.pkce_verifier');
  const expectedState = sessionStorage.getItem(stateKey);
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  const domain = env.VITE_COGNITO_DOMAIN;
  if (
    !verifier ||
    !expectedState ||
    state !== expectedState ||
    !clientId ||
    !domain
  ) {
    authError('Sign-in response could not be validated. Please sign in again.');
    sessionStorage.removeItem('datascout.pkce_verifier');
    sessionStorage.removeItem(stateKey);
    history.replaceState({}, '', location.pathname);
    return;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: location.origin + location.pathname,
    code_verifier: verifier,
  });
  try {
    const response = await fetch(`https://${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok)
      throw new Error('Sign-in could not be completed. Please try again.');
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token)
      throw new Error('Identity provider returned no access token.');
    localStorage.setItem(storageKey, tokens.access_token);
    if (tokens.refresh_token)
      sessionStorage.setItem(refreshKey, tokens.refresh_token);
    localStorage.setItem(
      expiryKey,
      String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    );
    sessionStorage.removeItem('datascout.pkce_verifier');
    sessionStorage.removeItem(stateKey);
    sessionStorage.removeItem('datascout.auth_error');
    history.replaceState({}, '', location.pathname);
    location.reload();
  } catch (error) {
    history.replaceState({}, '', location.pathname);
    authError(error instanceof Error ? error.message : 'Sign-in failed.');
  }
}

export async function getValidToken(): Promise<string | null> {
  if (env.VITE_DEMO_MODE === 'true') return 'mock-access-token';
  const token = localStorage.getItem(storageKey);
  if (!token) return null;
  const expiry = Number(localStorage.getItem(expiryKey) || 0);
  if (expiry > Date.now() + 60_000) return token;
  const refreshToken = sessionStorage.getItem(refreshKey);
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  const domain = env.VITE_COGNITO_DOMAIN;
  if (!refreshToken || !clientId || !domain) return token;
  try {
    const response = await fetch(`https://${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) throw new Error('Refresh token rejected');
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token)
      throw new Error('Identity provider returned no access token');
    localStorage.setItem(storageKey, tokens.access_token);
    if (tokens.refresh_token)
      sessionStorage.setItem(refreshKey, tokens.refresh_token);
    localStorage.setItem(
      expiryKey,
      String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    );
    return tokens.access_token;
  } catch {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(expiryKey);
    sessionStorage.removeItem(refreshKey);
    return null;
  }
}

export async function signIn() {
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  const domain = env.VITE_COGNITO_DOMAIN;
  if (!clientId || !domain)
    throw new Error(
      'Configure VITE_COGNITO_CLIENT_ID and VITE_COGNITO_DOMAIN to enable Cognito sign-in.',
    );
  const verifier = base64url(random(48));
  const state = base64url(random(24));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem('datascout.pkce_verifier', verifier);
  sessionStorage.setItem(stateKey, state);
  const authorize = new URL(`https://${domain}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope:
        env.VITE_COGNITO_SCOPES ||
          'openid email profile datascout-api/search datascout-api/read datascout-api/compare',
    redirect_uri: location.origin + location.pathname,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString();
  location.assign(authorize);
}

export function signOut() {
  localStorage.removeItem(storageKey);
  localStorage.removeItem(expiryKey);
  sessionStorage.removeItem(refreshKey);
  sessionStorage.removeItem('datascout.pkce_verifier');
  sessionStorage.removeItem(stateKey);
  const domain = env.VITE_COGNITO_DOMAIN;
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  if (env.VITE_DEMO_MODE !== 'true' && domain && clientId) {
    const logout = new URL(`https://${domain}/logout`);
    logout.search = new URLSearchParams({
      client_id: clientId,
      logout_uri: location.origin + location.pathname,
    }).toString();
    location.assign(logout);
  } else location.reload();
}
