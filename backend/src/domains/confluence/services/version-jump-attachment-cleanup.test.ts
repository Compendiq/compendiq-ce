/**
 * #1773 — the version-jump delete/keep rule, driven with real body texts.
 *
 * The selection only parses bodies (JSDOM) and reads nothing else, so these
 * tests need no database, filesystem or mocks. The end-to-end behaviour
 * (routes, real cache directory, sync) is covered by
 * `sync-service-version-jump-cache.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { getLocalFilenameForImageSource } from '../../../core/services/image-references.js';
import {
  selectVersionJumpCacheDeletions,
  type VersionJumpLocalSources,
} from './version-jump-attachment-cleanup.js';

const K = '4242';

const noLocalContent: VersionJumpLocalSources = {
  bodyHtml: null,
  draftBodyHtml: null,
  bodyStorage: null,
  draftBodyStorage: null,
  spaceKey: 'DEV',
  versionBodiesHtml: [],
};

function image(filename: string): string {
  return `<ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
}

function diagram(name: string): string {
  return `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">${name}</ac:parameter></ac:structured-macro>`;
}

function diagramFiles(name: string): string[] {
  return [`${name}.png`, `${name}.drawio`, `${name}.drawio.png`];
}

describe('selectVersionJumpCacheDeletions (#1773 delete/keep rule)', () => {
  it('removes files the incoming body references and files nothing local references, keeps files only local content references', () => {
    const removed = selectVersionJumpCacheDeletions({
      cached: [
        'evidence.png',
        'orphan.png',
        'draft shot.png',
        'body-only.png',
        'storage-only.png',
        'history-only.png',
        'manual.pdf',
      ],
      incomingStorage: `<p>v8</p>${image('evidence.png')}`,
      spaceKey: 'DEV',
      local: {
        ...noLocalContent,
        bodyHtml: `<p>v7</p><img src="/api/attachments/${K}/evidence.png"><img src="/api/attachments/${K}/body-only.png">`,
        draftBodyHtml: `<p>draft</p><img src="/api/attachments/${K}/draft%20shot.png">`,
        bodyStorage: `${image('evidence.png')}${image('storage-only.png')}`,
        versionBodiesHtml: [`<p>v6</p><img src="/api/attachments/${K}/history-only.png">`],
      },
    });

    // evidence.png is named locally too, but the incoming body wins: it must be
    // fetched fresh, because a same-name upstream change keeps no version.
    expect(removed).toEqual(['evidence.png', 'orphan.png', 'manual.pdf']);
  });

  it("treats a draw.io diagram's .png, .drawio and .drawio.png as one unit on both sides", () => {
    const removed = selectVersionJumpCacheDeletions({
      cached: [
        ...diagramFiles('arch'),
        ...diagramFiles('legacy'),
        ...diagramFiles('sketch'),
        ...diagramFiles('gone'),
      ],
      incomingStorage: diagram('arch'),
      spaceKey: 'DEV',
      local: {
        ...noLocalContent,
        // `arch` is local as well; the incoming body still wins.
        bodyStorage: diagram('arch') + diagram('legacy'),
        // A diagram only history names, in the HTML the converter writes.
        versionBodiesHtml: [
          `<div class="confluence-drawio" data-diagram-name="sketch" data-drawio-source="/api/attachments/${K}/sketch.drawio"><img src="/api/attachments/${K}/sketch.png"></div>`,
        ],
      },
    });

    expect(removed).toEqual([...diagramFiles('arch'), ...diagramFiles('gone')]);
  });

  it('names cross-page and external images the way their download named them', () => {
    const crossPage = (spaceKey: string) => getLocalFilenameForImageSource({
      kind: 'attachment',
      attachmentFilename: 'shared.png',
      sourcePageTitle: 'Other',
      sourceSpaceKey: spaceKey,
    });
    const external = getLocalFilenameForImageSource({
      kind: 'external-url',
      url: 'https://cdn.example.com/logo.png',
    });
    const crossPageRef =
      '<ac:image><ri:attachment ri:filename="shared.png"><ri:page ri:content-title="Other" /></ri:attachment></ac:image>';
    expect(crossPage('NEW')).not.toBe(crossPage('OLD'));

    const removed = selectVersionJumpCacheDeletions({
      cached: [crossPage('NEW'), crossPage('OLD'), external],
      // The incoming body resolves the page-less space key against the synced
      // space, as syncImageAttachments does when it downloads.
      incomingStorage: `${crossPageRef}<ac:image><ri:url ri:value="https://cdn.example.com/logo.png" /></ac:image>`,
      spaceKey: 'NEW',
      // The stored body was downloaded under the row's own space key.
      local: { ...noLocalContent, bodyStorage: crossPageRef, spaceKey: 'OLD' },
    });

    expect(removed).toEqual([crossPage('NEW'), external]);
  });
});
