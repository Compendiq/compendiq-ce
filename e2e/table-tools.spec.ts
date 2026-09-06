import { test, expect } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

// Table actions now live in the contextual toolbar, not retired edge overlays.
test('insert a table, expand it, and add a row and column', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('e2e_table'));
  await authenticateContext(page.context(), session);
  await page.goto('/pages/new');
  await expect(page.locator('.tiptap')).toBeVisible();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  const table = page.locator('.tiptap table');
  await expect(table).toBeVisible();
  await table.locator('th, td').first().click();
  const tools = page.getByRole('toolbar', { name: 'Table editing controls' });
  await expect(tools).toBeVisible();
  await tools.getByRole('button', { name: 'Expand table to page width' }).click();
  await expect(table).toHaveAttribute('data-layout', 'full-width');
  const columns = await table.locator('tr').first().locator('th, td').count();
  await tools.getByRole('button', { name: 'Add column after', exact: true }).click();
  await expect(table.locator('tr').first().locator('th, td')).toHaveCount(columns + 1);
  const rows = await table.locator('tr').count();
  await tools.getByRole('button', { name: 'Add row below', exact: true }).click();
  await expect(table.locator('tr')).toHaveCount(rows + 1);
  await tools.getByRole('button', { name: 'Return table to standard width' }).click();
  await expect(table).not.toHaveAttribute('data-layout', 'full-width');
});
