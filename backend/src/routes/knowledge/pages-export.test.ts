import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';

// Mock pdf-service with vi.hoisted to avoid hoisting issues
const { mockGeneratePdf } = vi.hoisted(() => {
  const mockGeneratePdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test'));
  return { mockGeneratePdf };
});

vi.mock('../../core/services/pdf-service.js', () => ({
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
vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn(),
}));

// Mock auth
vi.mock('../../core/plugins/auth.js', () => ({
  default: vi.fn(),
}));

// Mock RBAC service
const { mockGetUserAccessibleSpaces } = vi.hoisted(() => {
  const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue(['SPACE1', 'SPACE2']);
  return { mockGetUserAccessibleSpaces };
});

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: mockGetUserAccessibleSpaces,
}));

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesExportRoutes } from './pages-export.js';
import { query } from '../../core/db/postgres.js';

const mockQuery = vi.mocked(query);

const TEST_USER_ID = '1';

async function buildTestApp() {
  const app = Fastify();
  await app.register(sensible);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'ValidationError',
        message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        statusCode: 400,
      });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
  });

  // Minimal auth decorator
  app.decorate('authenticate', async () => {
    /* no-op for tests */
  });
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });

  await app.register(pagesExportRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('pages-export routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['SPACE1', 'SPACE2']);
    app = await buildTestApp();
  });

  describe('POST /api/pages/:id/export/pdf', () => {
    it('should return a PDF for a standalone page owned by user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Test Article', body_html: '<p>Hello</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' }],
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

    it('should return a PDF for a Confluence page with space access', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Confluence Page', body_html: '<p>Content</p>', source: 'confluence', space_key: 'SPACE1', created_by_user_id: null, visibility: null }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/export/pdf',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should return 404 for a Confluence page without space access', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Secret Page', body_html: '<p>Secret</p>', source: 'confluence', space_key: 'RESTRICTED', created_by_user_id: null, visibility: null }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/99/export/pdf',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for another user private standalone page', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Private Page', body_html: '<p>Private</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: '999', visibility: 'private' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/5/export/pdf',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should allow export of shared standalone page not owned by user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ title: 'Shared Page', body_html: '<p>Shared</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: '999', visibility: 'shared' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/7/export/pdf',
      });

      expect(response.statusCode).toBe(200);
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
        rows: [{ title: 'Hello World! @#$% Test', body_html: '<p>content</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' }],
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
    it('should merge multiple accessible pages into a single PDF', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, title: 'Page One', body_html: '<p>One</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' },
          { id: 2, title: 'Page Two', body_html: '<p>Two</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' },
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

    it('should filter out unauthorized pages in batch export', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, title: 'Accessible', body_html: '<p>Ok</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' },
          { id: 2, title: 'Restricted', body_html: '<p>No</p>', source: 'confluence', space_key: 'RESTRICTED', created_by_user_id: null, visibility: null },
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
      // Only the accessible page should be exported
      expect(mockGeneratePdf).toHaveBeenCalledTimes(1);
      expect(mockGeneratePdf).toHaveBeenCalledWith('<p>Ok</p>', { title: 'Accessible' });
    });

    it('should return 404 when all pages are unauthorized', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, title: 'Restricted', body_html: '<p>No</p>', source: 'confluence', space_key: 'RESTRICTED', created_by_user_id: null, visibility: null },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: [1] },
      });

      expect(response.statusCode).toBe(404);
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

    it('should return 400 when pageIds contains non-numeric values', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: ['abc', 'def'] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should coerce string pageIds to numbers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, title: 'Page One', body_html: '<p>One</p>', source: 'standalone', space_key: '_standalone', created_by_user_id: TEST_USER_ID, visibility: 'private' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: { pageIds: ['1', '2'] },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 400 when body is null', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/export/pdf',
        payload: null,
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
