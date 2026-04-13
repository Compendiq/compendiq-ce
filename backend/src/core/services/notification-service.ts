import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';

export interface CreateNotificationParams {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  sourceUserId?: string;
  sourcePageId?: number;
}

export interface Notification {
  id: number;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  sourceUserId: string | null;
  sourcePageId: number | null;
  isRead: boolean;
  createdAt: Date;
}

export interface NotificationPreference {
  type: string;
  inApp: boolean;
  email: boolean;
}

/**
 * Creates a notification for a user, respecting their in-app preference.
 * This function never throws -- notification failures are logged but do not block operations.
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  try {
    // Check user's preferences first
    const prefs = await query<{ in_app: boolean }>(
      'SELECT in_app FROM notification_preferences WHERE user_id = $1 AND type = $2',
      [params.userId, params.type],
    );

    // Default to enabled if no preference set
    const inApp = prefs.rows.length === 0 || prefs.rows[0]?.in_app;
    if (!inApp) return;

    await query(
      `INSERT INTO notifications (user_id, type, title, body, link, source_user_id, source_page_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.userId,
        params.type,
        params.title,
        params.body ?? null,
        params.link ?? null,
        params.sourceUserId ?? null,
        params.sourcePageId ?? null,
      ],
    );
  } catch (err) {
    // Notification creation must never block the main operation
    logger.error({ err, type: params.type, userId: params.userId }, 'Failed to create notification');
  }
}

export interface ListNotificationsFilter {
  userId: string;
  unreadOnly?: boolean;
  type?: string;
  limit?: number;
  offset?: number;
}

/**
 * Lists notifications for a user with optional filtering and pagination.
 */
export async function listNotifications(
  filter: ListNotificationsFilter,
): Promise<{ items: Notification[]; total: number }> {
  const conditions: string[] = ['user_id = $1'];
  const values: unknown[] = [filter.userId];
  let paramIdx = 2;

  if (filter.unreadOnly) {
    conditions.push('is_read = FALSE');
  }

  if (filter.type) {
    conditions.push(`type = $${paramIdx++}`);
    values.push(filter.type);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM notifications ${whereClause}`,
    values,
  );
  const countRow = countResult.rows[0];
  if (!countRow) throw new Error('Expected a row from COUNT query');
  const total = parseInt(countRow.count, 10);

  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  const result = await query<{
    id: number;
    user_id: string;
    type: string;
    title: string;
    body: string | null;
    link: string | null;
    source_user_id: string | null;
    source_page_id: number | null;
    is_read: boolean;
    created_at: Date;
  }>(
    `SELECT id, user_id, type, title, body, link, source_user_id, source_page_id, is_read, created_at
     FROM notifications ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...values, limit, offset],
  );

  return {
    items: result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
      sourceUserId: row.source_user_id,
      sourcePageId: row.source_page_id,
      isRead: row.is_read,
      createdAt: row.created_at,
    })),
    total,
  };
}

/**
 * Returns the count of unread notifications for the bell badge.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from COUNT query');
  return parseInt(row.count, 10);
}

/**
 * Marks a single notification as read.
 * Returns true if the notification existed and belonged to the user.
 */
export async function markAsRead(notificationId: number, userId: string): Promise<boolean> {
  const result = await query(
    'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
    [notificationId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Marks all notifications as read for a user.
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const result = await query(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
    [userId],
  );
  return result.rowCount ?? 0;
}

/**
 * Dismisses (deletes) a single notification.
 * Returns true if the notification existed and belonged to the user.
 */
export async function dismissNotification(notificationId: number, userId: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
    [notificationId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Gets notification preferences for a user.
 */
export async function getPreferences(userId: string): Promise<NotificationPreference[]> {
  const result = await query<{ type: string; in_app: boolean; email: boolean }>(
    'SELECT type, in_app, email FROM notification_preferences WHERE user_id = $1 ORDER BY type',
    [userId],
  );
  return result.rows.map((row) => ({
    type: row.type,
    inApp: row.in_app,
    email: row.email,
  }));
}

/**
 * Upserts a notification preference for a user.
 */
export async function updatePreference(
  userId: string,
  type: string,
  inApp: boolean,
  email: boolean,
): Promise<void> {
  await query(
    `INSERT INTO notification_preferences (user_id, type, in_app, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, type) DO UPDATE SET in_app = $3, email = $4`,
    [userId, type, inApp, email],
  );
}

/**
 * Adds a user as a watcher of an article.
 */
export async function watchArticle(pageId: number, userId: string): Promise<void> {
  await query(
    'INSERT INTO article_watchers (page_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [pageId, userId],
  );
}

/**
 * Removes a user from watching an article.
 * Returns true if they were actually watching.
 */
export async function unwatchArticle(pageId: number, userId: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM article_watchers WHERE page_id = $1 AND user_id = $2',
    [pageId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Returns whether a user is watching a specific article.
 */
export async function isWatching(pageId: number, userId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM article_watchers WHERE page_id = $1 AND user_id = $2) as exists',
    [pageId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from EXISTS query');
  return row.exists;
}

/**
 * Returns all user IDs watching a given article.
 */
export async function getArticleWatchers(pageId: number): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    'SELECT user_id FROM article_watchers WHERE page_id = $1',
    [pageId],
  );
  return result.rows.map((r) => r.user_id);
}
