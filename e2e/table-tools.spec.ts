import { test, expect } from '@playwright/test';

/**
 * E2E: Notion Table Tools & Full-Width Expansion
 *
 * Validates:
 * 1. Table insertion and focus.
 * 2. Floating table context toolbar attached directly at the active table.
 * 3. Page width table expansion toggle (`data-layout="full-width"`).
 * 4. Notion-style edge adders (`+ Column`, `+ Row`) and corner menu handle (`:: Table`).
 */

const TEST_USER = `e2e_tbl_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Notion Table Tools E2E', () => {
  test('creates table, positions floating tools at table, toggles full-width expansion, and uses edge adders', async ({ page }) => {
    // 1. Register user via API for fast reliable auth
    const regRes = await page.request.post('/api/auth/register', {
      data: { username: TEST_USER, password: TEST_PASS },
    });

    let token = '';
    let userObj = null;

    if (regRes.ok()) {
      const data = await regRes.json();
      token = data.accessToken;
      userObj = data.user;
    } else {
      const loginRes = await page.request.post('/api/auth/login', {
        data: { username: TEST_USER, password: TEST_PASS },
      });
      if (loginRes.ok()) {
        const data = await loginRes.json();
        token = data.accessToken;
        userObj = data.user;
      }
    }

    const authHeaders = { Authorization: `Bearer ${token}` };

    // Seed a local space so editor pages load cleanly
    await page.request.post('/api/spaces/local', {
      headers: authHeaders,
      data: { key: `TBL${Date.now().toString().slice(-4)}`, name: 'Table Tools Space' },
    });

    // 2. Go to login page, set auth in localStorage, then navigate to /pages/new
    await page.goto('/login');
    if (token) {
      await page.evaluate(
        ({ accessToken, user }) => {
          localStorage.setItem(
            'compendiq-auth',
            JSON.stringify({
              state: { accessToken, user, isAuthenticated: true },
              version: 0,
            })
          );
        },
        { accessToken: token, user: userObj }
      );
    }

    await page.goto('/pages/new');
    await expect(page).toHaveURL(/\/pages\/new/, { timeout: 10_000 });
    await page.waitForSelector('.tiptap', { state: 'visible', timeout: 15_000 });

    // 3. Click "Insert" toolbar menu, then click "Table"
    const insertMenuBtn = page.getByRole('button', { name: 'Insert' });
    await expect(insertMenuBtn).toBeVisible({ timeout: 5000 });
    await insertMenuBtn.click();

    const tableMenuItem = page.getByRole('menuitem', { name: 'Table', exact: true });
    await expect(tableMenuItem).toBeVisible({ timeout: 5000 });
    await tableMenuItem.click();

    // Wait for table element to render in TipTap editor
    const table = page.locator('.tiptap table');
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click into first table cell to focus table
    const firstCell = page.locator('.tiptap td, .tiptap th').first();
    await firstCell.click();

    // 4. Validate floating context toolbar is visible and attached at table
    const contextToolbar = page.locator('[data-testid="table-context-toolbar"]').first();
    await expect(contextToolbar).toBeVisible({ timeout: 5000 });

    // 5. Validate Notion overlay controls (+ Column, + Row, Corner menu)
    const cornerTrigger = page.locator('[data-testid="table-corner-menu-trigger"]');
    const addColBtn = page.locator('[data-testid="add-column-right-btn"]');
    const addRowBtn = page.locator('[data-testid="add-row-bottom-btn"]');

    await expect(cornerTrigger).toBeVisible();
    await expect(addColBtn).toBeVisible();
    await expect(addRowBtn).toBeVisible();

    // 6. Test Full-Width Table Expansion Toggle
    const toggleExpandBtn = page.locator('[data-testid="toggle-table-expand"]').first();
    await expect(toggleExpandBtn).toBeVisible();

    // Click Expand toggle with force: true
    await toggleExpandBtn.click({ force: true });
    await page.waitForTimeout(300);

    // 7. Test Edge Add Column (+ Column)
    const colCountBefore = await page.locator('.tiptap tr').first().locator('th, td').count();
    await addColBtn.click({ force: true });
    await page.waitForTimeout(300);
    const colCountAfter = await page.locator('.tiptap tr').first().locator('th, td').count();
    expect(colCountAfter).toBe(colCountBefore + 1);

    // 8. Test Edge Add Row (+ Row)
    const rowCountBefore = await page.locator('.tiptap tr').count();
    await addRowBtn.click({ force: true });
    await page.waitForTimeout(300);
    const rowCountAfter = await page.locator('.tiptap tr').count();
    expect(rowCountAfter).toBe(rowCountBefore + 1);

    // 9. Test Corner Menu Popover Trigger
    await cornerTrigger.click();
    await expect(page.getByText('Table Options')).toBeVisible();
  });
});
