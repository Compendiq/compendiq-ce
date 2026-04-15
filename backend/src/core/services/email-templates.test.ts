import { describe, it, expect } from 'vitest';
import {
  syncCompleted,
  syncFailed,
  knowledgeRequestCreated,
  articleComment,
  licenseExpiry,
} from './email-templates.js';

describe('email-templates', () => {
  it('syncCompleted generates valid HTML', () => {
    const result = syncCompleted({
      userName: 'Alice',
      spacesCount: 3,
      pagesCount: 42,
      duration: '2m 30s',
    });
    expect(result.subject).toContain('42 pages');
    expect(result.html).toContain('Alice');
    expect(result.html).toContain('42');
    expect(result.html).toContain('2m 30s');
    expect(result.html).toContain('<!DOCTYPE html>');
  });

  it('syncFailed generates valid HTML with error', () => {
    const result = syncFailed({
      userName: 'Bob',
      errorMessage: 'Connection refused',
      spaceKey: 'DEV',
    });
    expect(result.subject).toContain('failed');
    expect(result.subject).toContain('DEV');
    expect(result.html).toContain('Connection refused');
  });

  it('knowledgeRequestCreated generates valid HTML', () => {
    const result = knowledgeRequestCreated({
      assigneeName: 'Charlie',
      requesterName: 'Diana',
      title: 'API Documentation',
      description: 'We need docs for the REST API',
      requestUrl: 'https://app.compendiq.local/requests/1',
    });
    expect(result.subject).toContain('API Documentation');
    expect(result.html).toContain('Charlie');
    expect(result.html).toContain('Diana');
    expect(result.html).toContain('View Request');
  });

  it('articleComment generates valid HTML', () => {
    const result = articleComment({
      authorName: 'Eve',
      recipientName: 'Frank',
      articleTitle: 'Getting Started',
      commentPreview: 'Great article!',
      articleUrl: 'https://app.compendiq.local/pages/1',
    });
    expect(result.subject).toContain('Getting Started');
    expect(result.html).toContain('Eve');
    expect(result.html).toContain('Great article!');
  });

  it('licenseExpiry generates valid HTML with urgency', () => {
    const result = licenseExpiry({
      adminName: 'Admin',
      daysRemaining: 5,
      expiryDate: '2026-04-20',
      tier: 'Professional',
    });
    expect(result.subject).toContain('5 days');
    expect(result.html).toContain('#dc2626'); // urgent red
    expect(result.html).toContain('Professional');
  });

  it('escapes HTML in user input', () => {
    const result = syncFailed({
      userName: '<script>alert("xss")</script>',
      errorMessage: '&<>"\'',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('&amp;');
  });
});
