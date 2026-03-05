import { Page } from '@playwright/test';

/**
 * Login as a test user via the API and return the access token.
 * This runs in the browser context via page.evaluate.
 */
export async function loginAsTestUser(
  page: Page,
  baseUrl: string,
): Promise<string> {
  const res = await page.evaluate(async (url) => {
    const resp = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'testpass123' }),
    });
    if (!resp.ok) {
      throw new Error(`Login failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
  }, baseUrl);

  return res.accessToken;
}

/**
 * Register a test user via the API. Ignores conflict errors (user already exists).
 */
export async function registerTestUser(
  page: Page,
  baseUrl: string,
): Promise<void> {
  await page.evaluate(async (url) => {
    const resp = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'testpass123' }),
    });
    // 409 = user already exists, that's fine
    if (!resp.ok && resp.status !== 409) {
      throw new Error(`Registration failed: ${resp.status} ${resp.statusText}`);
    }
  }, baseUrl);
}
