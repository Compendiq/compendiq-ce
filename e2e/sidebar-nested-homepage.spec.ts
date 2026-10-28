import { test, expect } from '@playwright/test';
import pg from 'pg';
import { authenticateContext, bearerHeaders, loginUser } from './helpers/auth';

test('nested Confluence homepage is detached before its children are promoted', async ({ page }, testInfo) => {
  const databaseUrl = process.env.POSTGRES_URL;
  const admin = process.env.COLLAB_E2E_ADMIN;
  const password = process.env.COLLAB_E2E_PASSWORD;
  if (!databaseUrl || !admin || !password) throw new Error('Disposable database and E2E admin credentials are required');
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.pathname !== '/kb_e2e') {
    throw new Error('Homepage fixture requires a loopback kb_e2e database');
  }
  const session = await loginUser(page.request, admin, password);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const spaceKey = `E2EHOME${suffix}`;
  const remoteIds = [`a-${suffix}`, `h-${suffix}`, `c-${suffix}`, `s-${suffix}`];
  try {
    await db.query("INSERT INTO spaces (space_key, space_name, source) VALUES ($1, $2, 'confluence')", [spaceKey, `Homepage ${suffix}`]);
    await db.query(`INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
      SELECT $1, 'user', $2, id FROM roles WHERE name = 'editor'`, [spaceKey, session.user.id]);
    const ids: number[] = [];
    for (const [index, title, parent] of [[0, 'Ancestor', null], [1, 'Homepage', remoteIds[0]], [2, 'Child', remoteIds[1]], [3, 'Sibling', remoteIds[0]]] as const) {
      const result = await db.query<{ id: number }>(
        "INSERT INTO pages (space_key, title, source, confluence_id, parent_id) VALUES ($1, $2, 'confluence', $3, $4) RETURNING id",
        [spaceKey, `${title} ${suffix}`, remoteIds[index], parent],
      );
      ids.push(result.rows[0]!.id);
    }
    const headers = bearerHeaders(session);
    const response = await page.request.put(`/api/spaces/${spaceKey}/home`, { headers, data: { homePageId: ids[1] } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const spaces = await page.request.get('/api/spaces', { headers });
    expect((await spaces.json()).find((space: { key: string }) => space.key === spaceKey).homepageId).toBe(String(ids[1]));
    const tree = await page.request.get(`/api/pages/tree?spaceKey=${spaceKey}`, { headers });
    expect(tree.ok()).toBeTruthy();
    const items = (await tree.json()).items;
    expect(items.find((item: { id: string }) => item.id === String(ids[1])).parentId).toBe(String(ids[0]));
    expect(items.find((item: { id: string }) => item.id === String(ids[2])).parentId).toBe(String(ids[1]));
    await authenticateContext(page.context(), session);
    await page.context().addInitScript((key) => {
      localStorage.setItem('compendiq-ui', JSON.stringify({ state: { treeSidebarSpaceKey: key }, version: 0 }));
    }, spaceKey);
    await page.goto('/pages');
    const ancestor = page.locator(`[role="treeitem"][data-page-id="${ids[0]}"]`);
    await expect(ancestor).toHaveCount(1);
    await ancestor.getByLabel('Expand').click();
    const rows = page.locator('[role="treeitem"][data-page-id]');
    await expect(rows).toHaveCount(3);
    for (const id of [ids[0], ids[2], ids[3]]) await expect(page.locator(`[role="treeitem"][data-page-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator(`[role="treeitem"][data-page-id="${ids[1]}"]`)).toHaveCount(0);
    const screenshot = testInfo.outputPath('nested-homepage.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('nested-homepage', { path: screenshot, contentType: 'image/png' });
    await ancestor.focus();
    await page.keyboard.press('ArrowDown');
    const focusedId = await page.locator('[role="treeitem"]:focus').getAttribute('data-page-id');
    expect([String(ids[2]), String(ids[3])]).toContain(focusedId);
    await page.reload();
    await expect(page.locator(`[role="treeitem"][data-page-id="${ids[2]}"]`)).toHaveCount(1);
  } finally {
    await db.query('UPDATE spaces SET custom_home_page_id = NULL WHERE space_key = $1', [spaceKey]);
    await db.query('DELETE FROM pages WHERE space_key = $1', [spaceKey]);
    await db.query('DELETE FROM space_role_assignments WHERE space_key = $1', [spaceKey]);
    await db.query('DELETE FROM spaces WHERE space_key = $1', [spaceKey]);
    await db.end();
  }
});
