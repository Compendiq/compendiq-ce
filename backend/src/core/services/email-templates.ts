/**
 * HTML email templates with inline CSS for Gmail/Outlook compatibility.
 *
 * All styles are inline — no external CSS references.
 */

const BASE_STYLES = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
  color: #1a1a2e;
`;

const CONTAINER = `
  max-width: 600px;
  margin: 0 auto;
  padding: 24px;
  background-color: #ffffff;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
`;

const HEADER = `
  font-size: 20px;
  font-weight: 600;
  color: #1a1a2e;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 2px solid #6366f1;
`;

const BUTTON = `
  display: inline-block;
  padding: 10px 24px;
  background-color: #6366f1;
  color: #ffffff;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 500;
  margin-top: 16px;
`;

const FOOTER = `
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  font-size: 12px;
  color: #94a3b8;
`;

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:20px;background-color:#f1f5f9;${BASE_STYLES}">
<div style="${CONTAINER}">
  <div style="${HEADER}">${title}</div>
  ${body}
  <div style="${FOOTER}">
    Sent by Compendiq &middot; Knowledge Base Management
  </div>
</div>
</body>
</html>`;
}

export interface SyncCompletedData {
  userName: string;
  spacesCount: number;
  pagesCount: number;
  duration: string;
}

export function syncCompleted(data: SyncCompletedData): { subject: string; html: string } {
  return {
    subject: `Sync completed — ${data.pagesCount} pages synced`,
    html: wrap('Sync Completed', `
      <p>Hi ${escapeHtml(data.userName)},</p>
      <p>Your Confluence sync has completed successfully.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0;color:#64748b;">Spaces</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;font-weight:600;">${data.spacesCount}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0;color:#64748b;">Pages synced</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;font-weight:600;">${data.pagesCount}</td></tr>
        <tr><td style="padding:8px;color:#64748b;">Duration</td><td style="padding:8px;font-weight:600;">${escapeHtml(data.duration)}</td></tr>
      </table>
    `),
  };
}

export interface SyncFailedData {
  userName: string;
  errorMessage: string;
  spaceKey?: string;
}

export function syncFailed(data: SyncFailedData): { subject: string; html: string } {
  return {
    subject: `Sync failed${data.spaceKey ? ` for ${data.spaceKey}` : ''}`,
    html: wrap('Sync Failed', `
      <p>Hi ${escapeHtml(data.userName)},</p>
      <p>Your Confluence sync has failed${data.spaceKey ? ` for space <strong>${escapeHtml(data.spaceKey)}</strong>` : ''}.</p>
      <div style="padding:12px;background:#fef2f2;border-radius:6px;border:1px solid #fecaca;margin:16px 0;">
        <strong style="color:#dc2626;">Error:</strong>
        <pre style="margin:8px 0 0;white-space:pre-wrap;color:#991b1b;font-size:13px;">${escapeHtml(data.errorMessage)}</pre>
      </div>
      <p>Please check your Confluence connection settings and try again.</p>
    `),
  };
}

export interface KnowledgeRequestData {
  assigneeName: string;
  requesterName: string;
  title: string;
  description: string;
  requestUrl?: string;
}

export function knowledgeRequestCreated(data: KnowledgeRequestData): { subject: string; html: string } {
  return {
    subject: `New knowledge request: ${data.title}`,
    html: wrap('Knowledge Request Assigned', `
      <p>Hi ${escapeHtml(data.assigneeName)},</p>
      <p><strong>${escapeHtml(data.requesterName)}</strong> has created a knowledge request and assigned it to you.</p>
      <div style="padding:12px;background:#f0f9ff;border-radius:6px;border:1px solid #bae6fd;margin:16px 0;">
        <strong>${escapeHtml(data.title)}</strong>
        <p style="margin:8px 0 0;color:#475569;font-size:14px;">${escapeHtml(data.description)}</p>
      </div>
      ${data.requestUrl ? `<a href="${escapeHtml(data.requestUrl)}" style="${BUTTON}">View Request</a>` : ''}
    `),
  };
}

export interface CommentData {
  authorName: string;
  recipientName: string;
  articleTitle: string;
  commentPreview: string;
  articleUrl?: string;
}

export function articleComment(data: CommentData): { subject: string; html: string } {
  return {
    subject: `New comment on "${data.articleTitle}"`,
    html: wrap('New Comment', `
      <p>Hi ${escapeHtml(data.recipientName)},</p>
      <p><strong>${escapeHtml(data.authorName)}</strong> commented on <em>${escapeHtml(data.articleTitle)}</em>:</p>
      <blockquote style="padding:12px;background:#f8fafc;border-left:3px solid #6366f1;margin:16px 0;color:#475569;font-style:italic;">
        ${escapeHtml(data.commentPreview)}
      </blockquote>
      ${data.articleUrl ? `<a href="${escapeHtml(data.articleUrl)}" style="${BUTTON}">View Article</a>` : ''}
    `),
  };
}

export interface LicenseExpiryData {
  adminName: string;
  daysRemaining: number;
  expiryDate: string;
  tier: string;
}

export function licenseExpiry(data: LicenseExpiryData): { subject: string; html: string } {
  const urgency = data.daysRemaining <= 7 ? '#dc2626' : '#f59e0b';
  return {
    subject: `License expiring in ${data.daysRemaining} days`,
    html: wrap('License Expiry Warning', `
      <p>Hi ${escapeHtml(data.adminName)},</p>
      <p>Your Compendiq <strong>${escapeHtml(data.tier)}</strong> license will expire in
        <span style="color:${urgency};font-weight:700;">${data.daysRemaining} days</span>
        (${escapeHtml(data.expiryDate)}).
      </p>
      <p>Please renew your license to continue using enterprise features.</p>
    `),
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
