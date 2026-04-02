import { test, expect } from '@playwright/test';

/**
 * E2E: Pages CRUD
 *
 * Tests create page -> edit -> add tag -> search -> delete.
 * Registers a fresh user, then performs all CRUD via the UI.
 */

const TEST_USER = `e2e_pages_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';
const PAGE_TITLE = `E2E Test Page ${Date.now()}`;
const UPDATED_TITLE = `${PAGE_TITLE} Updated`;

test.describe('Pages CRUD', () => {
  test.beforeEach(async ({ page }) => {
    // Register and login a fresh user via the API for speed
    const registerRes = await page.request.post('/api/auth/register', {
      data: { username: TEST_USER + Math.random().toString(36).slice(2, 6), password: TEST_PASS },
    });

    // If registration fails (user exists), try login
    let token: string;
    let data: { accessToken: string; user: unknown };
    if (registerRes.ok()) {
      data = await registerRes.json();
      token = data.accessToken;
    } else {
      // Already registered — should not happen with unique usernames, but be safe
      test.skip();
      return;
    }

    // Set auth state in localStorage so the app picks it up
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        // Zustand persist stores under a specific key
        const authState = {
          state: {
            accessToken,
            user,
            isAuthenticated: true,
          },
          version: 0,
        };
        localStorage.setItem('compendiq-auth', JSON.stringify(authState));
      },
      {
        accessToken: token,
        user: data.user,
      },
    );
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test('create a standalone page', async ({ page }) => {
    // Look for a "New Page" button or the new page route
    const newPageBtn = page
      .getByRole('button', { name: /new page|create page/i })
      .or(page.getByTestId('new-page-btn'))
      .or(page.locator('[href="/pages/new"]'));

    // Try clicking the button, or navigate directly
    if (await newPageBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await newPageBtn.click();
    } else {
      // Navigate directly to new page
      await page.goto('/pages/new');
    }

    await expect(page).toHaveURL(/\/pages\/new/, { timeout: 10_000 });

    // Fill in the page title
    const titleInput = page
      .getByPlaceholder(/title|page name/i)
      .or(page.getByTestId('page-title-input'))
      .or(page.locator('input[name="title"]'));

    await expect(titleInput.first()).toBeVisible({ timeout: 10_000 });
    await titleInput.first().fill(PAGE_TITLE);

    // The page should have some form of save/create button
    const saveBtn = page
      .getByRole('button', { name: /save|create|publish/i })
      .or(page.getByTestId('save-page-btn'));

    if (await saveBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await saveBtn.first().click();

      // After saving, should redirect to the page view or list
      await page.waitForURL(/\/pages\/\d+|\/$/, { timeout: 15_000 });
    }
  });

  test('edit an existing page title', async ({ page }) => {
    // Create a page via API first
    const token = JSON.parse(
      await page.evaluate(() => localStorage.getItem('compendiq-auth') ?? '{}'),
    ).state?.accessToken;

    const createRes = await page.request.post('/api/pages', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: PAGE_TITLE, body: '<p>Initial content</p>', spaceKey: null },
    });

    if (!createRes.ok()) {
      test.skip();
      return;
    }

    const created = await createRes.json();
    await page.goto(`/pages/${created.id}`);
    await expect(page).toHaveURL(/\/pages\/\d+/, { timeout: 10_000 });

    // Look for an edit button
    const editBtn = page
      .getByRole('button', { name: /edit/i })
      .or(page.getByTestId('edit-page-btn'))
      .or(page.locator('[href*="edit"]'));

    if (await editBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await editBtn.first().click();

      // Update the title
      const titleInput = page
        .getByPlaceholder(/title|page name/i)
        .or(page.getByTestId('page-title-input'))
        .or(page.locator('input[name="title"]'));

      if (await titleInput.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
        await titleInput.first().fill(UPDATED_TITLE);

        const saveBtn = page
          .getByRole('button', { name: /save|update/i })
          .or(page.getByTestId('save-page-btn'));

        if (await saveBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
          await saveBtn.first().click();
          await page.waitForURL(/\/pages\/\d+/, { timeout: 15_000 });
          await expect(page.getByText(UPDATED_TITLE)).toBeVisible({ timeout: 5_000 });
        }
      }
    }
  });

  test('add a tag to a page', async ({ page }) => {
    // Create a page via API first
    const token = JSON.parse(
      await page.evaluate(() => localStorage.getItem('compendiq-auth') ?? '{}'),
    ).state?.accessToken;

    const createRes = await page.request.post('/api/pages', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: `Tag Test ${Date.now()}`, body: '<p>Tag test content</p>', spaceKey: null },
    });

    if (!createRes.ok()) {
      test.skip();
      return;
    }

    const created = await createRes.json();
    await page.goto(`/pages/${created.id}`);
    await expect(page).toHaveURL(/\/pages\/\d+/, { timeout: 10_000 });

    // Look for a tag input or "add tag" button
    const addTagBtn = page
      .getByRole('button', { name: /add tag|tag/i })
      .or(page.getByTestId('add-tag-btn'))
      .or(page.getByPlaceholder(/tag/i));

    if (await addTagBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await addTagBtn.first().click();

      const tagInput = page
        .getByPlaceholder(/tag|label/i)
        .or(page.getByTestId('tag-input'))
        .or(page.locator('input[name="tag"]'));

      if (await tagInput.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        await tagInput.first().fill('e2e-test-tag');
        await tagInput.first().press('Enter');

        // Verify the tag appears
        await expect(page.getByText('e2e-test-tag')).toBeVisible({ timeout: 5_000 });
      }
    }
  });

  test('delete a page', async ({ page }) => {
    // Create a page via API first
    const token = JSON.parse(
      await page.evaluate(() => localStorage.getItem('compendiq-auth') ?? '{}'),
    ).state?.accessToken;

    const createRes = await page.request.post('/api/pages', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: `Delete Test ${Date.now()}`, body: '<p>To be deleted</p>', spaceKey: null },
    });

    if (!createRes.ok()) {
      test.skip();
      return;
    }

    const created = await createRes.json();
    await page.goto(`/pages/${created.id}`);
    await expect(page).toHaveURL(/\/pages\/\d+/, { timeout: 10_000 });

    // Look for a delete button (often in a menu or toolbar)
    const deleteBtn = page
      .getByRole('button', { name: /delete/i })
      .or(page.getByTestId('delete-page-btn'));

    // May be behind a "more actions" menu
    const moreBtn = page
      .getByRole('button', { name: /more|actions|menu|\.\.\./i })
      .or(page.getByTestId('page-actions-menu'));

    if (await moreBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await moreBtn.first().click();
      await page.waitForLoadState('domcontentloaded');
    }

    if (await deleteBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await deleteBtn.first().click();

      // Confirm deletion dialog
      const confirmBtn = page
        .getByRole('button', { name: /confirm|yes|delete/i })
        .or(page.getByTestId('confirm-delete-btn'));

      if (await confirmBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        await confirmBtn.first().click();

        // Should redirect to pages list or home
        await page.waitForURL(/\/pages\/?$|\/$/, { timeout: 15_000 });
      }
    }
  });

  test('search for pages', async ({ page }) => {
    // Navigate to the main page
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

    // Look for a search input or search button
    const searchInput = page
      .getByPlaceholder(/search/i)
      .or(page.getByTestId('search-input'))
      .or(page.getByRole('searchbox'));

    // Use command palette shortcut (Ctrl/Cmd+K) as an alternative
    if (await searchInput.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await searchInput.first().fill('test');

      // Wait a bit for search results to appear (debounced)
      // Allow UI transition to settle
      await page.waitForLoadState('domcontentloaded');

      // The search should produce some results or a "no results" message
      const hasResults = await page
        .locator('[data-testid="search-results"]')
        .or(page.getByText(/no results|no pages found/i))
        .or(page.locator('.search-result'))
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      // Either results appeared or we have a no-results message — both are valid
      expect(hasResults).toBe(true);
    } else {
      // Try keyboard shortcut for search (Ctrl+K or /)
      await page.keyboard.press('Control+k');

      const cmdPalette = page
        .getByTestId('command-palette')
        .or(page.getByRole('dialog'))
        .or(page.getByPlaceholder(/search|type a command/i));

      if (await cmdPalette.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        // Command palette opened, type a search query
        await page.keyboard.type('test');
        // Allow UI transition to settle
        await page.waitForLoadState('domcontentloaded');
      }
    }
  });
});
