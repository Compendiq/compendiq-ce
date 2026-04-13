import { FastifyInstance } from 'fastify';
import {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  dismissNotification,
  getPreferences,
  updatePreference,
  watchArticle,
  unwatchArticle,
  isWatching,
} from '../../core/services/notification-service.js';

export async function notificationRoutes(fastify: FastifyInstance) {
  // All notification routes require auth
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /notifications — List notifications (filter: unread, type; paginated)
  fastify.get('/notifications', async (request) => {
    const { unread, type, limit, offset } = request.query as {
      unread?: string;
      type?: string;
      limit?: string;
      offset?: string;
    };

    return listNotifications({
      userId: request.userId,
      unreadOnly: unread === 'true',
      type,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  });

  // GET /notifications/count — Unread count (for bell badge)
  fastify.get('/notifications/count', async (request) => {
    const count = await getUnreadCount(request.userId);
    return { count };
  });

  // POST /notifications/:id/read — Mark single notification as read
  fastify.post<{ Params: { id: string } }>('/notifications/:id/read', async (request, reply) => {
    const notificationId = parseInt(request.params.id, 10);
    if (isNaN(notificationId)) {
      return reply.badRequest('Invalid notification ID');
    }

    const found = await markAsRead(notificationId, request.userId);
    if (!found) {
      return reply.notFound('Notification not found');
    }
    return { message: 'Marked as read' };
  });

  // POST /notifications/read-all — Mark all as read
  fastify.post('/notifications/read-all', async (request) => {
    const count = await markAllAsRead(request.userId);
    return { message: 'All notifications marked as read', count };
  });

  // DELETE /notifications/:id — Dismiss notification
  fastify.delete<{ Params: { id: string } }>('/notifications/:id', async (request, reply) => {
    const notificationId = parseInt(request.params.id, 10);
    if (isNaN(notificationId)) {
      return reply.badRequest('Invalid notification ID');
    }

    const found = await dismissNotification(notificationId, request.userId);
    if (!found) {
      return reply.notFound('Notification not found');
    }
    return { message: 'Notification dismissed' };
  });

  // GET /notification-preferences — Get preferences
  fastify.get('/notification-preferences', async (request) => {
    const preferences = await getPreferences(request.userId);
    return { preferences };
  });

  // PUT /notification-preferences — Update preferences
  fastify.put('/notification-preferences', async (request, reply) => {
    const { type, inApp, email } = request.body as {
      type?: string;
      inApp?: boolean;
      email?: boolean;
    };

    if (!type || typeof type !== 'string') {
      return reply.badRequest('type is required');
    }

    await updatePreference(
      request.userId,
      type,
      inApp ?? true,
      email ?? false,
    );
    return { message: 'Preference updated' };
  });

  // POST /pages/:id/watch — Watch an article
  fastify.post<{ Params: { id: string } }>('/pages/:id/watch', async (request, reply) => {
    const pageId = parseInt(request.params.id, 10);
    if (isNaN(pageId)) {
      return reply.badRequest('Invalid page ID');
    }

    await watchArticle(pageId, request.userId);
    return { message: 'Watching article' };
  });

  // DELETE /pages/:id/watch — Unwatch an article
  fastify.delete<{ Params: { id: string } }>('/pages/:id/watch', async (request, reply) => {
    const pageId = parseInt(request.params.id, 10);
    if (isNaN(pageId)) {
      return reply.badRequest('Invalid page ID');
    }

    await unwatchArticle(pageId, request.userId);
    return { message: 'Unwatched article' };
  });

  // GET /pages/:id/watch — Check if watching
  fastify.get<{ Params: { id: string } }>('/pages/:id/watch', async (request, reply) => {
    const pageId = parseInt(request.params.id, 10);
    if (isNaN(pageId)) {
      return reply.badRequest('Invalid page ID');
    }

    const watching = await isWatching(pageId, request.userId);
    return { watching };
  });
}
