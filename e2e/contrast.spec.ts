import { test, expect, Page } from '@playwright/test';

/**
 * E2E: WCAG-AA contrast audit (accessibility + amber-as-AI bundle, task 6/6)
 *
 * Audits every visible text element across 6 routes × 2 themes and fails if any
 * text-on-background pair falls below the WCAG-AA contrast minimum:
 *   - 4.5:1 for normal text
 *   - 3:1 for large text (>= 18px, or >= 14px with font-weight >= 700)
 *
 * Locks the bundle's accessibility fixes in against future regressions.
 * Audit logic mirrors the in-browser script used for design evidence gathering
 * on 2026-05-17.
 */

const TEST_USER = `e2e_contrast_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

const ROUTES = [
  '/',
  '/graph',
  '/ai',
  '/settings',
  '/settings/system/license',
  '/admin/analytics',
];

interface ContrastViolation {
  route: string;
  theme: 'light' | 'dark';
  text: string;
  ratio: number;
  fg: string;
  bg: string;
  selector: string;
}

async function auditPage(
  page: Page,
  route: string,
  theme: 'light' | 'dark',
): Promise<ContrastViolation[]> {
  return await page.evaluate(
    ({ route, theme }) => {
      function parse(c: string) {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map((s) => parseFloat(s));
        return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
      }
      function L(c: { r: number; g: number; b: number }) {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      function ratio(
        fg: { r: number; g: number; b: number },
        bg: { r: number; g: number; b: number },
      ) {
        const l1 = L(fg),
          l2 = L(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function bgOf(el: HTMLElement): { r: number; g: number; b: number; a: number } {
        let n: HTMLElement | null = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          const p = parse(c);
          if (p && p.a > 0) return p;
          n = n.parentElement;
        }
        return theme === 'dark'
          ? { r: 18, g: 18, b: 18, a: 1 }
          : { r: 247, g: 247, b: 247, a: 1 };
      }
      function describe(el: HTMLElement): string {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          el.className && typeof el.className === 'string'
            ? '.' + el.className.split(/\s+/).slice(0, 2).join('.')
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 80);
      }
      const out: ContrastViolation[] = [];
      const all = Array.from(
        document.querySelectorAll<HTMLElement>('body *'),
      ).filter((el) => {
        if (!el.offsetParent) return false;
        const t = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
          .map((n) => (n.textContent ?? '').trim())
          .join(' ');
        return t.length > 0;
      });
      for (const el of all) {
        const s = getComputedStyle(el);
        const fg = parse(s.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const r = ratio(fg, bg);
        const fs = parseFloat(s.fontSize);
        const fw = parseInt(s.fontWeight);
        const isLarge = fs >= 18 || (fs >= 14 && fw >= 700);
        const min = isLarge ? 3 : 4.5;
        if (r < min) {
          const text = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => (n.textContent ?? '').trim())
            .join(' ')
            .slice(0, 40);
          if (!text) continue;
          out.push({
            route,
            theme,
            text,
            ratio: +r.toFixed(2),
            fg: `rgb(${fg.r},${fg.g},${fg.b})`,
            bg: `rgb(${bg.r},${bg.g},${bg.b})`,
            selector: describe(el),
          });
        }
      }
      return out;
    },
    { route, theme },
  );
}

test.describe('WCAG-AA contrast audit', () => {
  let authToken: string;
  let authUser: { id: string; username: string; role: string };

  test.beforeEach(async ({ page }) => {
    // Same registration + localStorage auth pattern as themes.spec.ts.
    const registerRes = await page.request.post('/api/auth/register', {
      data: {
        username: TEST_USER + Math.random().toString(36).slice(2, 6),
        password: TEST_PASS,
      },
    });

    if (!registerRes.ok()) {
      test.skip();
      return;
    }

    const data = await registerRes.json();
    authToken = data.accessToken;
    authUser = data.user;

    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        const authState = {
          state: { accessToken, user, isAuthenticated: true },
          version: 0,
        };
        localStorage.setItem('compendiq-auth', JSON.stringify(authState));
      },
      { accessToken: authToken, user: authUser },
    );
  });

  for (const route of ROUTES) {
    for (const theme of ['light', 'dark'] as const) {
      test(`contrast: ${route} (${theme})`, async ({ page }) => {
        // 1. Set theme. graphite-honey is the default after fresh visit; flip
        //    to honey-linen via the header toggle if light is requested.
        await page.goto('/');
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          'graphite-honey',
        );

        if (theme === 'light') {
          await page
            .getByRole('button', { name: /switch to light mode/i })
            .click();
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            'honey-linen',
          );
        }

        // 2. Navigate to the target route under the chosen theme.
        await page.goto(route);
        await page.waitForLoadState('networkidle');

        // 3. Run the audit.
        const violations = await auditPage(page, route, theme);

        // 4. If anything failed, dump a compact summary to test output so the
        //    failure is actionable without re-running with --trace.
        if (violations.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `\nWCAG-AA violations on ${route} (${theme}): ${violations.length}\n` +
              violations
                .map(
                  (v) =>
                    `  - [${v.ratio}:1] ${v.selector}\n      fg=${v.fg} bg=${v.bg} text="${v.text}"`,
                )
                .join('\n'),
          );
        }

        expect(
          violations,
          `WCAG-AA violations on ${route} (${theme})`,
        ).toHaveLength(0);
      });
    }
  }
});
