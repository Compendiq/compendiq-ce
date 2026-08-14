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

const TEST_USER = `e2e_table_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Notion Table Tools E2E', () => {
  test('creates table, positions floating tools at table, toggles full-width expansion, and uses edge adders', async ({ page }) => {
    // 1. Go to login page
    await page.goto('/login');
    await expect(page.getByText(/Sign in to Compendiq|Create your account/)).toBeVisible({ timeout: 10_000 });

    // 2. Switch to registration mode
    const createOneLink = page.getByRole('button', { name: /Create one/i });
    if (await createOneLink.isVisible().catch(() => false)) {
      await createOneLink.click();
    }

    // 3. Register user
    await page.getByLabel('Username').fill(TEST_USER);
    await page.locator('input[type="password"]').first().fill(TEST_PASS);
    await page.getByRole('button', { name: /Create Account/i }).click();

    // 4. Wait for main app redirect
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // 5. Navigate to create page
    const newPageBtn = page
      .getByRole('button', { name: /new page|create page/i })
      .or(page.getByTestId('new-page-btn'))
      .or(page.locator('[href="/pages/new"]'));

    if (await newPageBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await newPageBtn.first().click();
    } else {
      await page.goto('/pages/new');
    }

    await page.waitForSelector('.tiptap', { state: 'visible', timeout: 15_000 });

    // 6. Click "Insert" toolbar menu, then click "Table"
    const insertMenuBtn = page.getByRole('button', { name: 'Insert' });
    await expect(insertMenuBtn).toBeVisible({ timeout: 5000 });
    await insertMenuBtn.click();

    const tableMenuItem = page.getByRole('menuitem', { name: 'Table' });
    await expect(tableMenuItem).toBeVisible({ timeout: 5000 });
    await tableMenuItem.click();

    // Wait for table element to render in TipTap editor
    const table = page.locator('.tiptap table');
    await expect(table).toBeVisible({ timeout: 5000 });

    // Click into first table cell to focus table
    const firstCell = page.locator('.tiptap td, .tiptap th').first();
    await firstCell.click();

    // 7. Validate floating context toolbar is visible and attached at table
    const contextToolbar = page.locator('[data-testid="table-context-toolbar"]');
    await expect(contextToolbar).toBeVisible({ timeout: 5000 });

    // 8. Validate Notion overlay controls (+ Column, + Row, Corner menu)
    const cornerTrigger = page.locator('[data-testid="table-corner-menu-trigger"]');
    const addColBtn = page.locator('[data-testid="add-column-right-btn"]');
    const addRowBtn = page.locator('[data-testid="add-row-bottom-btn"]');

    await expect(cornerTrigger).toBeVisible();
    await expect(addColBtn).toBeVisible();
    await expect(addRowBtn).toBeVisible();

    // 9. Test Full-Width Table Expansion Toggle
    const toggleExpandBtn = page.locator('[data-testid="toggle-table-expand"]');
    await expect(toggleExpandBtn).toBeVisible();

    // Click Expand toggle
    await toggleExpandBtn.click();

    // Verify data-layout="full-width" attribute on table node
    await expect(table).toHaveAttribute('data-layout', 'full-width');

    // Click again to toggle back to standard width
    await toggleExpandBtn.click();
    await expect(table).toHaveAttribute('data-layout', 'default');

    // 10. Test Edge Add Column (+ Column)
    const colCountBefore = await page.locator('.tiptap tr').first().locator('th, td').count();
    await addColBtn.click();
    const colCountAfter = await page.locator('.tiptap tr').first().locator('th, td').count();
    expect(colCountAfter).toBe(colCountBefore + 1);

    // 11. Test Edge Add Row (+ Row)
    const rowCountBefore = await page.locator('.tiptap tr').count();
    await addRowBtn.click();
    const rowCountAfter = await page.locator('.tiptap tr').count();
    expect(rowCountAfter).toBe(rowCountBefore + 1);

    // 12. Test Corner Menu Popover Trigger
    await cornerTrigger.click();
    await expect(page.getByText('Table Options')).toBeVisible();
  });
});
