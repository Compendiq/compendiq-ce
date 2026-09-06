import { request, type APIResponse, type FullConfig } from '@playwright/test';
import { bearerHeaders, loginUser, registerUser, uniqueUsername } from './auth';

const CI_SETTINGS = {
  registrationMode: 'open',
  rateLimitAuth: 1000,
  rateLimitGlobal: 10000,
  rateLimitAdmin: 1000,
} as const;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

async function requireSuccess(response: APIResponse, action: string): Promise<void> {
  if (!response.ok()) {
    throw new Error(`${action} failed: HTTP ${response.status()} ${await response.text()}`);
  }
}

/** Validate before webServer can run migrations, not just before provisioning. */
export function ciEnvironment() {
  if (process.env.E2E_CI !== '1') {
    throw new Error('CI provisioning requires E2E_CI=1; never use it against an existing instance.');
  }
  const baseURL = process.env.E2E_BASE_URL;
  const postgresURL = process.env.POSTGRES_URL;
  const username = process.env.COLLAB_E2E_ADMIN;
  const password = process.env.COLLAB_E2E_PASSWORD;
  if (!baseURL || !postgresURL || !username || !password) {
    throw new Error('CI provisioning requires E2E_BASE_URL, POSTGRES_URL, COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD.');
  }
  const app = new URL(baseURL);
  const database = new URL(postgresURL);
  if (app.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(app.hostname) || app.pathname !== '/'
    || app.username || app.password || app.search || app.hash
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || !LOOPBACK_HOSTS.includes(database.hostname) || database.pathname !== '/kb_e2e') {
    throw new Error('Refusing CI provisioning: require a loopback HTTP origin and the disposable loopback kb_e2e database.');
  }
  return { baseURL, username, password };
}

/** Only the dedicated CI config may provision a fresh, disposable local stack. */
export default async function ciSetup(config: FullConfig): Promise<void> {
  const { baseURL, username, password } = ciEnvironment();
  if (config.projects.some(project => project.use.baseURL !== baseURL)) {
    throw new Error('Refusing CI provisioning: every project must use E2E_BASE_URL.');
  }

  const api = await request.newContext({ baseURL, timeout: 30_000, maxRedirects: 0 });
  try {
    const statusResponse = await api.get('/api/health/setup-status');
    await requireSuccess(statusResponse, 'Reading fresh-instance status');
    const status = await statusResponse.json();
    if (status?.setupComplete !== false || status?.steps?.admin !== false) {
      throw new Error('Refusing CI provisioning: instance is already provisioned or returned an invalid setup status.');
    }
    const created = await api.post('/api/setup/admin', { data: { username, password } });
    await requireSuccess(created, 'Creating the initial CI admin (fresh instance required)');
    if (created.status() !== 201) {
      throw new Error('CI admin creation did not return 201; refusing to reuse an existing instance.');
    }
    // Use the same real session helper as the specs; do not invent stored-token auth.
    const admin = await loginUser(api, username, password);
    if (admin.user.role !== 'admin') throw new Error('The provisioned CI account is not an admin.');
    const headers = bearerHeaders(admin);
    const settingsResponse = await api.put('/api/admin/settings', { headers, data: CI_SETTINGS });
    await requireSuccess(settingsResponse, 'Opening registration and raising disposable CI rate limits');
    const savedResponse = await api.get('/api/admin/settings', { headers });
    await requireSuccess(savedResponse, 'Reading back CI settings');
    const saved = await savedResponse.json();
    for (const [key, value] of Object.entries(CI_SETTINGS)) {
      if (saved[key] !== value) throw new Error(`CI setting ${key} was not persisted.`);
    }
    // Registration must actually work, not merely be reported as open.
    const probe = await registerUser(api, uniqueUsername('ci_registration_probe'));
    const removed = await api.delete(`/api/admin/users/${probe.user.id}`, { headers });
    await requireSuccess(removed, 'Removing the CI registration probe');
    console.log('Provisioned a fresh CI admin, verified open registration and disposable rate limits.');
  } finally {
    await api.dispose();
  }
}
