import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock playwright-core so tests don't need a real browser.
// vi.mock is hoisted so the factory must not reference top-level variables.
// Instead we use vi.hoisted() to define mocks that are available at hoist time.
const { mockPage, mockBrowser } = vi.hoisted(() => {
  const mockPdfBuffer = Buffer.from('%PDF-1.4 mock');

  const mockPage = {
    setContent: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn().mockResolvedValue(mockPdfBuffer),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    isConnected: vi.fn().mockReturnValue(true),
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockPage, mockBrowser };
});

vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

import { generatePdf, closeBrowser } from './pdf-service.js';

describe('pdf-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset connected state
    mockBrowser.isConnected.mockReturnValue(true);
  });

  afterEach(async () => {
    await closeBrowser();
  });

  describe('generatePdf', () => {
    it('should generate a PDF buffer from HTML content', async () => {
      const html = '<p>Hello, World!</p>';
      const result = await generatePdf(html, { title: 'Test Article' });

      expect(result).toBeInstanceOf(Buffer);
      expect(mockPage.setContent).toHaveBeenCalledOnce();
      expect(mockPage.pdf).toHaveBeenCalledOnce();
      expect(mockPage.close).toHaveBeenCalledOnce();
    });

    it('should include title in the rendered HTML', async () => {
      await generatePdf('<p>Content</p>', { title: 'My Title' });

      const calledHtml = mockPage.setContent.mock.calls[0][0] as string;
      expect(calledHtml).toContain('My Title');
      // Title should be HTML-escaped in the cover page
      expect(calledHtml).toContain('<!DOCTYPE html>');
    });

    it('should escape HTML characters in title', async () => {
      await generatePdf('<p>Content</p>', { title: '<script>alert("xss")</script>' });

      const calledHtml = mockPage.setContent.mock.calls[0][0] as string;
      expect(calledHtml).toContain('&lt;script&gt;');
      expect(calledHtml).not.toContain('<script>alert');
    });

    it('should render without cover page div when no title is provided', async () => {
      await generatePdf('<p>Content</p>', {});

      const calledHtml = mockPage.setContent.mock.calls[0][0] as string;
      // The CSS class is always in the stylesheet, but no cover-page div should be rendered
      expect(calledHtml).not.toContain('<div class="cover-page">');
    });

    it('should set A4 format with margins', async () => {
      await generatePdf('<p>Content</p>', {});

      const pdfOptions = mockPage.pdf.mock.calls[0][0];
      expect(pdfOptions.format).toBe('A4');
      expect(pdfOptions.margin).toEqual({
        top: '60px',
        bottom: '60px',
        left: '40px',
        right: '40px',
      });
    });

    it('should use waitUntil networkidle for images', async () => {
      await generatePdf('<img src="data:image/png;base64,abc"/>', {});

      const setContentOptions = mockPage.setContent.mock.calls[0][1];
      expect(setContentOptions.waitUntil).toBe('networkidle');
    });

    it('should always close the page even on error', async () => {
      mockPage.pdf.mockRejectedValueOnce(new Error('PDF generation failed'));

      await expect(generatePdf('<p>Broken</p>', {})).rejects.toThrow('PDF generation failed');
      expect(mockPage.close).toHaveBeenCalledOnce();
    });

    it('should relaunch browser if disconnected', async () => {
      const { chromium } = await import('playwright-core');

      // First call establishes connection
      await generatePdf('<p>First</p>', {});
      expect(chromium.launch).toHaveBeenCalledTimes(1);

      // Simulate disconnect
      mockBrowser.isConnected.mockReturnValue(false);

      await generatePdf('<p>Second</p>', {});
      expect(chromium.launch).toHaveBeenCalledTimes(2);
    });

    it('should pass executablePath from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var', async () => {
      const { chromium } = await import('playwright-core');

      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/usr/lib/chromium/chromium';
      try {
        await generatePdf('<p>Content</p>', {});

        expect(chromium.launch).toHaveBeenCalledWith(
          expect.objectContaining({
            executablePath: '/usr/lib/chromium/chromium',
          }),
        );
      } finally {
        delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      }
    });

    it('should not set executablePath when env var is not set', async () => {
      const { chromium } = await import('playwright-core');
      delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

      await generatePdf('<p>Content</p>', {});

      const launchCall = (chromium.launch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(launchCall.executablePath).toBeUndefined();
    });
  });

  describe('closeBrowser', () => {
    it('should close the browser when called', async () => {
      // Launch by generating a PDF first
      await generatePdf('<p>Content</p>', {});

      await closeBrowser();
      expect(mockBrowser.close).toHaveBeenCalledOnce();
    });
  });
});
