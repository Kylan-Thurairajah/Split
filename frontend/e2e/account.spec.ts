import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

const authURL = process.env.SPLIT_E2E_AUTH_URL;
const principal = { id: 'test-provider-user', name: 'Casey', email: 'casey@example.test', emailVerified: true };
const owner = { id: 'owner', name: 'Casey', color: '#A68BDC' };
const cartId = '0'.repeat(32);
const receiptId = '1'.repeat(32);
const tokenPayload = Buffer.from(JSON.stringify({ sub: principal.id, exp: 4_071_139_200 })).toString('base64url');
const token = 'mock.' + tokenPayload + '.unsig';
const bearer = 'Bearer ' + token;

const cart = { id: cartId, name: 'Weekend supplies', demo: false, private: true, version: 1,
  access: 'owner', actorId: owner.id, participants: [owner], items: [], totalCents: 0, totals: { [owner.id]: 0 } };
const receipt = { ...cart, id: receiptId, name: 'Completed supplies', completedAt: '2026-01-04T18:00:00Z' };

async function mockAccount(context: BrowserContext, baseURL: string, baseAuthURL: string) {
  let signedIn = false;
  let created = false;
  let profile = { ...owner, needsName: true, theme: null as 'light' | 'dark' | null };
  const authBase = baseAuthURL.replace(/\/$/, '');
  const appOrigin = new URL(baseURL).origin;
  expect(new URL(authBase).origin).not.toBe(appOrigin);
  const authHeaders = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };

  // Prevent unexpected browser requests from reaching any real identity provider.
  await context.route(url => url.origin !== appOrigin, async route => {
    const url = route.request().url();
    if (!url.startsWith(authBase + '/')) return route.abort();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      ...authHeaders,
      'access-control-allow-headers': route.request().headers()['access-control-request-headers'] ?? '',
    } });

    const endpoint = new URL(url).pathname.slice(new URL(authBase).pathname.replace(/\/$/, '').length);
    const respond = (json: unknown, headers?: Record<string, string>) => route.fulfill({
      json, headers: { ...authHeaders, ...headers },
    });
    if (endpoint === '/sign-up/email') {
      expect(route.request().postDataJSON()).toMatchObject({ email: principal.email, password: 'test-password' });
      return respond({ user: { ...principal, emailVerified: false }, token: 'mock-session' });
    }
    if (endpoint === '/email-otp/send-verification-otp') {
      expect(route.request().postDataJSON()).toMatchObject({ email: principal.email, type: 'sign-in' });
      return respond({ success: true });
    }
    if (endpoint === '/sign-in/email-otp') {
      expect(route.request().postDataJSON()).toEqual({ email: principal.email, otp: '123456' });
      signedIn = true;
      return respond({ user: principal, token: 'mock-session' });
    }
    if (endpoint === '/get-session') return respond(signedIn ? {
      user: principal, session: { id: 'mock-session', userId: principal.id, token: 'mock-session',
        expiresAt: '2099-01-01T00:00:00Z' },
    } : null, signedIn ? { 'set-auth-jwt': token, 'access-control-expose-headers': 'set-auth-jwt' } : undefined);
    if (endpoint === '/token') return respond(signedIn ? { token } : {});
    if (endpoint === '/sign-out') {
      signedIn = false;
      return respond({ success: true });
    }
    return route.abort();
  });

  await context.route(url => url.origin === appOrigin && url.pathname.startsWith('/api/'), async route => {
    const { pathname } = new URL(route.request().url());
    const authorized = signedIn && route.request().headers().authorization === bearer;
    if (!authorized) return route.fulfill({ status: 404, json: { error: 'Cart not found.' } });
    if (pathname === '/api/me') {
      if (route.request().method() === 'PATCH') {
        const update = route.request().postDataJSON();
        profile = { ...profile, ...update, needsName: !update.name && profile.needsName };
      }
      return route.fulfill({ json: profile });
    }
    if (pathname === '/api/me/carts') return route.fulfill({ json: created ? [cart, receipt] : [receipt] });
    if (pathname === '/api/carts' && route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ private: true, name: cart.name });
      created = true;
      return route.fulfill({ status: 201, json: cart });
    }
    if (pathname.endsWith('/ws-ticket')) return route.fulfill({ status: 201, json: { ticket: 'mock-ticket' } });
    if (pathname === '/api/carts/' + cartId && created) return route.fulfill({ json: cart });
    if (pathname === '/api/carts/' + receiptId) return route.fulfill({ json: receipt });
    return route.fulfill({ status: 404, json: { error: 'Cart not found.' } });
  });

  await context.routeWebSocket(/\/api\/carts\/[a-f0-9]{32}\/ws/, socket => {
    expect(new URL(socket.url()).searchParams.get('ticket')).toBe('mock-ticket');
  });
}

test('private carts restore after reload and require a signed-in account', async ({ page, context, baseURL }) => {
  test.skip(!authURL, 'Set SPLIT_E2E_AUTH_URL to the cross-origin auth URL used to build the test export.');
  await mockAccount(context, baseURL!, authURL!);

  await page.goto('/my-carts');
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByRole('button', { name: 'Create account with password', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(principal.email);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with an email code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(principal.email);
  await page.getByRole('button', { name: 'Send sign-in code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Sign-in code', exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/my-carts/);
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill(principal.name);
  await page.getByRole('button', { name: 'Save display name', exact: true }).click();
  await page.getByRole('button', { name: 'Use dark mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use light mode', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New private cart', exact: true }).click();
  await page.getByRole('textbox', { name: 'Cart name', exact: true }).fill(cart.name);
  await page.getByRole('button', { name: 'Create private cart', exact: true }).click();
  await expect(page.getByRole('heading', { name: cart.name, exact: true })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  await page.goto('/my-carts');
  await expect(page.getByRole('link', { name: cart.name, exact: true })).toBeVisible();
  await page.getByRole('link', { name: receipt.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkout complete', exact: true })).toBeVisible();
  await expect(page.getByText(/simulated checkout|demo checkout/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download receipt', exact: true })).toBeVisible();
  await page.goto('/my-carts');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(new URL('/', baseURL).href);
  await page.goto('/cart/' + cartId);
  await expect(page.getByRole('heading', { name: cart.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(principal.email);
  await page.getByRole('button', { name: 'Send sign-in code', exact: true }).click();
  await page.getByRole('textbox', { name: 'Sign-in code', exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: cart.name, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use light mode', exact: true })).toBeVisible();
});
