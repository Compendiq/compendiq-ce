import { describe, expect, it } from 'vitest';
import { markFormattedVersionDiff } from './version-formatted-diff';

describe('markFormattedVersionDiff', () => {
  it('preserves current formatting while marking replaced words', () => {
    const result = markFormattedVersionDiff(
      '<h2>Deploy</h2><p>Use the <strong>old</strong> service.</p>',
      '<h2>Deploy</h2><p>Use the <strong>new</strong> service.</p>',
    );
    const document = new DOMParser().parseFromString(result, 'text/html');

    expect(document.querySelector('h2')?.textContent).toBe('Deploy');
    expect(document.querySelector('strong ins')?.textContent).toBe('new');
    expect(document.querySelector('strong del')?.textContent).toBe('old');
  });

  it('marks content removed from the end of the formatted document', () => {
    const result = markFormattedVersionDiff(
      '<p>Keep this. Remove this.</p>',
      '<p>Keep this.</p>',
    );
    const document = new DOMParser().parseFromString(result, 'text/html');

    expect(document.querySelector('del')?.textContent).toContain('Remove this.');
  });

  it('marks a fully removed document instead of returning an empty preview', () => {
    const result = markFormattedVersionDiff('<p>Removed document.</p>', '');
    const document = new DOMParser().parseFromString(result, 'text/html');

    expect(document.body.querySelector('del')?.textContent).toBe('Removed document.');
  });
});
