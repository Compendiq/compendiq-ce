import { test, expect } from '@playwright/test';
import pg from 'pg';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername } from './helpers/auth';

test('global unread count includes notifications beyond the first page', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('e2e_notifications'));
  const client = new pg.Client({ connectionString: process.env.POSTGRES_URL });
  await client.connect();
  try {
    await client.query(`INSERT INTO notifications (user_id, type, title, is_read, created_at)
      SELECT $1, 'general', 'Notification ' || n, n <> 0,
             now() + n * interval '1 second'
      FROM generate_series(0, 50) n`, [session.user.id]);
  } finally {
    await client.end();
  }
  const headers = bearerHeaders(session);
  const count = await page.request.get('/api/notifications/count', { headers });
  expect(count.ok()).toBeTruthy();
  expect(await count.json()).toEqual({ count: 1 });
  const first = await page.request.get('/api/notifications?limit=50&offset=0', { headers });
  expect(first.ok()).toBeTruthy();
  expect((await first.json()).total).toBe(51);
  await authenticateContext(page.context(), session);
  await page.goto('/');
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByTestId('mark-all-read')).toBeVisible();
  await expect(page.getByText('Notification 50', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await page.getByText('Notification 0', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  const after = await page.request.get('/api/notifications/count', { headers });
  expect(await after.json()).toEqual({ count: 0 });
});
