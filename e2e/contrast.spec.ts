import { test, expect, Page } from '@playwright/test';
import { authenticateContext, loginUser, registerUser, uniqueUsername } from './helpers/auth';

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

const ROUTES = [
  { route: '/', admin: false, ready: '[data-testid="library-filter-panel"]' },
  { route: '/graph', admin: false, ready: '[data-testid="graph-empty-state"], [data-testid="graph-picker-landing"], [data-testid="graph-container"]' },
  { route: '/ai', admin: false, ready: '[data-testid="ask-input"]' },
  { route: '/settings/personal/confluence', admin: false, ready: '#confluence-url' },
  { route: '/settings/system/license', admin: true, ready: '[data-testid="license-status"]' },
  { route: '/admin/analytics', admin: true, ready: '[data-testid="analytics-gate"]' },
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
      function oklabToSrgb(L: number, a: number, b: number, alpha: number) {
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;
        const linR = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        const linG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        const linB = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
        const encode = (x: number) => {
          const clamped = Math.max(0, Math.min(1, x));
          const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
          return Math.round(srgb * 255);
        };
        return { r: encode(linR), g: encode(linG), b: encode(linB), a: alpha };
      }
      function parse(c: string): { r: number; g: number; b: number; a: number } | null {
        const rgb = c.match(/rgba?\(([^)]+)\)/);
        if (rgb) {
          const parts = rgb[1].replace(/\s*\/\s*/g, ',').split(/[\s,]+/).filter(Boolean).map(parseFloat);
          if (parts.length >= 3) {
            return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
          }
        }
        const srgb = c.match(/color\(srgb\s+([^)]+)\)/);
        if (srgb) {
          const parts = srgb[1].replace(/\s*\/\s*/g, ' ').trim().split(/\s+/).map(parseFloat);
          if (parts.length >= 3) {
            return {
              r: Math.round(parts[0]! * 255),
              g: Math.round(parts[1]! * 255),
              b: Math.round(parts[2]! * 255),
              a: parts[3] ?? 1,
            };
          }
        }
        const oklab = c.match(/oklab\(([^)]+)\)/);
        if (oklab) {
          const parts = oklab[1].replace(/\s*\/\s*/g, ' ').trim().split(/\s+/).map(parseFloat);
          if (parts.length >= 3) {
            return oklabToSrgb(parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1);
          }
        }
        const oklch = c.match(/oklch\(([^)]+)\)/);
        if (oklch) {
          const parts = oklch[1].replace(/\s*\/\s*/g, ' ').trim().split(/\s+/).map(parseFloat);
          if (parts.length >= 3) {
            const rad = (parts[2]! * Math.PI) / 180;
            return oklabToSrgb(parts[0]!, parts[1]! * Math.cos(rad), parts[1]! * Math.sin(rad), parts[3] ?? 1);
          }
        }
        return null;
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
      function compositeOver(
        fg: { r: number; g: number; b: number; a: number },
        bg: { r: number; g: number; b: number },
      ) {
        const a = Math.max(0, Math.min(1, fg.a));
        const inv = 1 - a;
        return {
          r: Math.round(fg.r * a + bg.r * inv),
          g: Math.round(fg.g * a + bg.g * inv),
          b: Math.round(fg.b * a + bg.b * inv),
          a: 1,
        };
      }
      function bgOf(el: HTMLElement): { r: number; g: number; b: number; a: number } {
        const layers: { r: number; g: number; b: number; a: number }[] = [];
        let base: { r: number; g: number; b: number; a: number } | null = null;
        let n: HTMLElement | null = el;
        while (n) {
          const p = parse(getComputedStyle(n).backgroundColor);
          if (p && p.a > 0) {
            if (p.a >= 0.999) {
              base = p;
              break;
            }
            layers.push(p);
          }
          n = n.parentElement;
        }
        let current = base ?? (theme === 'dark'
          ? { r: 18, g: 18, b: 18, a: 1 }
          : { r: 247, g: 247, b: 247, a: 1 });
        for (let i = layers.length - 1; i >= 0; i--) {
          current = compositeOver(layers[i]!, current);
        }
        return current;
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
  for (const { route, admin, ready } of ROUTES) {
    for (const theme of ['light', 'dark'] as const) {
      test(`contrast: ${route} (${theme})`, async ({ context, page }) => {
        // Cookies belong to this test's browser context; a request-fixture
        // session from beforeAll would not survive a new page's refresh.
        let session;
        if (admin) {
          const username = process.env.COLLAB_E2E_ADMIN;
          const password = process.env.COLLAB_E2E_PASSWORD;
          if (!username || !password) throw new Error('Admin contrast audit requires COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD');
          session = await loginUser(context.request, username, password);
          expect(session.user.role).toBe('admin');
        } else {
          session = await registerUser(context.request, uniqueUsername('e2e_contrast'));
          expect(session.user.role).toBe('user');
        }
        await authenticateContext(context, session);
        // Explicitly choose the audited palette, independent of the OS and
        // the admin's profile; System is the current first-visit default.
        await page.goto('/');
        await page.getByTestId('theme-toggle').click();
        await page.getByTestId(`theme-option-${theme}`).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'paper' : 'graphite');

        // 2. Navigate to the target route under the chosen theme.
        await page.goto(route);
        await expect(page).toHaveURL(new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        await expect(page.locator(ready)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme-type', theme);
        // Measure settled colors, not a button's transparent-to-primary
        // entrance transition. Infinite loading indicators need not finish.
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(document.getAnimations()
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
        });

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
