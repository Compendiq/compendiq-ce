import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pdf-service with vi.hoisted to avoid hoisting issues
const { mockGeneratePdf } = vi.hoisted(() => {
  const mockGeneratePdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test'));
  return { mockGeneratePdf };
});

vi.mock('../services/pdf-service.js', () => ({
  generatePdf: mockGeneratePdf,
}));

// Mock pdf-lib for batch exports
const { mockMergedDoc, mockLoadedDoc } = vi.hoisted(() => {
  const mockPage = { ref: 'mock-page' };
  const mockMergedDoc = {
    addPage: vi.fn(),
    copyPages: vi.fn().mockResolvedValue([mockPage]),
    save: vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70])), // %PDF
  };
  const mockLoadedDoc = {
    getPageIndices: vi.fn().mockReturnValue([0]),
  };
  return { mockMergedDoc, mockLoadedDoc };
});

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    create: vi.fn().mockResolvedValue(mockMergedDoc),
    load: vi.fn().mockResolvedValue(mockLoadedDoc),
  },
}));

// Mock postgres
vi.mock('../db/postgres.js', () => ({
  query: vi.fn(),
}));

// Mock auth
vi.mock('../plugins/auth.js', () => ({
  default: vi.fn(),
}));

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesExportRoutes } from './pages-export.js';
import { query } from '../db/postgres.js';

const mockQuery = vi.mocked(query);

async function buildTestApp() {
  const app = Fastify();
  await app.register(sensible);

  // Minimal auth decorator
  app.decorate('authenticate', async () => {
    /* no-op for tests */
  });
  app.decorateRequest('userId', 0);
  app.addHook('onRequest', async (request) => {
    request.userId = 1;
  });

  await app.register(pagesExportRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('pages-export routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  describe('POST /api/pages/:id/export/pdf', () => {
    it('should return a PDF for a valid page', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Test Article', body_html: '<p>Hello</p>' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/export/pdf',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('attachment; filename=');
      expect(response.headers['content-disposition']).toContain('.pdf');
      expect(mockGeneratePdf).toHaveBeenCalledWith('<p>Hello</p>', { title: 'Test Article' });
    });

    it('should return 404 for non-existent page', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/999/export/pdf',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should sanitize filename from title', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Hello World! @#$% Test', body_html: '<p>content</p>' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/1/export/pdf',
      });

      expect(response.statusCode).toBe(200);
      const disposition = response.headers['content-disposition'] as string;
      // Should only contain safe chars
      expect(disposition).toMatch(/filename="[a-z0-9-]+\.pdf"/);
    });
  });

  describe('POST /api/pages/export/pdf', () => {
    it('should merge multiple pages into a single PDF', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, title: 'Page One', body_html: '<p>One</p>' },
          { id: 2, title: 'Page Two', body_html: '<p>Two</p>' },
        ],
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: [1, 2] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toBe('attachment; filename="kb-export.pdf"');
      expect(mockGeneratePdf).toHaveBeenCalledTimes(2);
    });

    it('should return 400 when pageIds is empty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when pageIds is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when more than 50 pages requested', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: Array.from({ length: 51 }, (_, i) => i + 1) },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 when no pages found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: [999, 998] },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
