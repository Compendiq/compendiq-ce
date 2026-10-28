import { test, expect } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername } from './helpers/auth';

test('graph filters follow reachable focus history and effective requests', async ({ page }, testInfo) => {
  const suffix = Date.now().toString(36);
  const session = await registerUser(page.request, uniqueUsername('graph_history'));
  await authenticateContext(page.context(), session);
  const auth = { headers: bearerHeaders(session) };
  const spaceKey = `GRAPH${suffix.toUpperCase()}`;
  const space = await page.request.post('/api/spaces/local', { ...auth, data: { key: spaceKey, name: `Graph ${suffix}` } });
  expect(space.ok(), await space.text()).toBeTruthy();
  const create = async (title: string, parentId?: number) => {
    const response = await page.request.post('/api/pages', {
      ...auth,
      data: { spaceKey, title, bodyHtml: '<p>Graph history fixture</p>', labels: ['history'], parentId },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json() as { id: number }).id;
  };
  const first = await create(`History Alpha ${suffix}`);
  const second = await create(`History Bravo ${suffix}`, first);
  // The picker is reachable only above the real 50-page size gate.
  for (let index = 0; index < 49; index++) await create(`History filler ${suffix} ${index}`);

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/graph/local?')) requests.push(request.url());
  });
  await page.goto(`/graph?focus=${first}&space=${spaceKey}&edgeTypes=parent_child&minScore=0.4&labels=history`);
  await expect(page.getByTestId('filter-edge-parent_child')).toBeChecked();
  await expect(page.getByTestId('filter-min-score')).toHaveValue('0.4');
  await page.getByTestId('graph-clear-focus-btn').click();
  await page.getByTestId('graph-picker-input').fill(`History Bravo ${suffix}`);
  await page.getByRole('option', { name: new RegExp(`History Bravo ${suffix}`) }).click();
  await expect(page.getByTestId('graph-filter-sidebar')).toBeVisible();
  await page.getByTestId('filter-min-score').fill('0.8');
  await expect(page).toHaveURL(/minScore=0\.8/);
  await page.goBack();
  await expect(page.getByTestId('graph-picker-input')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('filter-min-score')).toHaveValue('0.4');
  await expect(page.getByTestId('filter-edge-parent_child')).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`focus=${first}`));
  await page.screenshot({ path: testInfo.outputPath('restored-a.png') });
  await page.goForward();
  await expect(page.getByTestId('graph-picker-input')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('filter-min-score')).toHaveValue('0.8');
  await expect(page).toHaveURL(new RegExp(`focus=${second}`));
  await page.screenshot({ path: testInfo.outputPath('restored-b.png') });
  expect(requests.some((url) => url.includes(`/pages/${first}/graph/local?`) && url.includes('minScore=0.4') && url.includes('labels=history'))).toBeTruthy();
  expect(requests.some((url) => url.includes(`/pages/${second}/graph/local?`) && url.includes('minScore=0.8') && url.includes('labels=history'))).toBeTruthy();
});
