import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export const E2E_PASSWORD = 'TestPassword123!';

export type E2eUser = {
  username: string;
  accessToken: string;
  user: { id: string; username: string; role: 'user' | 'admin' };
};

/**
 * Zustand persist payload the SPA rehydrates. Version 1 strips any
 * `accessToken` (CWE-922); session init remints from the refresh cookie.
 */
export function persistAuthState(user: E2eUser['user']): string {
  return JSON.stringify({
    state: { user, isAuthenticated: true },
    version: 1,
  });
}

export function uniqueUsername(prefix: string): string {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}_${stamp}`.slice(0, 50);
}

async function sessionFromAuthResponse(
  res: Awaited<ReturnType<APIRequestContext['post']>>,
  action: string,
  username: string,
): Promise<E2eUser> {
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`${action} ${username} failed: ${res.status()} ${body}`);
  }
  const data = (await res.json()) as {
    accessToken: string;
    user: E2eUser['user'];
  };
  if (!data.accessToken || !data.user?.id) {
    throw new Error(`${action} ${username} returned no session`);
  }
  return { username: data.user.username, accessToken: data.accessToken, user: data.user };
}

export async function registerUser(
  request: APIRequestContext,
  username: string,
  password = E2E_PASSWORD,
): Promise<E2eUser> {
  const res = await request.post('/api/auth/register', {
    data: { username, password },
  });
  return sessionFromAuthResponse(res, 'register', username);
}

export async function loginUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<E2eUser> {
  const res = await request.post('/api/auth/login', {
    data: { username, password },
  });
  return sessionFromAuthResponse(res, 'login', username);
}

export async function authenticateContext(
  context: BrowserContext,
  session: E2eUser,
): Promise<void> {
  await context.addInitScript((payload: string) => {
    localStorage.setItem('compendiq-auth', payload);
  }, persistAuthState(session.user));
}

export async function openAuthenticatedPage(
  context: BrowserContext,
  session: E2eUser,
  path = '/',
): Promise<Page> {
  await authenticateContext(context, session);
  const page = await context.newPage();
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  return page;
}

export function bearerHeaders(session: E2eUser): { Authorization: string } {
  return { Authorization: `Bearer ${session.accessToken}` };
}
