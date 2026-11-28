/**
 * #1954: a collaborative document persisted before #1954 loads unchanged.
 *
 * `COLLAB_PRE_1954` was captured on `bff6d4ec` with that commit's schema
 * (backend/scripts/capture-collab-schema-fixture-1954.ts): the full
 * `Y.encodeStateAsUpdate` of a room seeded from Confluence HTML and then edited,
 * and the HTML the old `yDocToHtml` produced for it.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { collabCarriesTaskIds, htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { COLLAB_PRE_1954 } from './__fixtures__/collab-pre-1954.js';

function loadFixture(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(COLLAB_PRE_1954.docStateBase64, 'base64'));
  return doc;
}

/** Every Y.XmlElement of the document's content, depth first. */
function elements(doc: Y.Doc): Y.XmlElement[] {
  return [...doc.getXmlFragment('default').createTreeWalker((type) => type instanceof Y.XmlElement)] as Y.XmlElement[];
}

/** The attribute keys of every formatted text run of the document. */
function textAttributeKeys(doc: Y.Doc): string[] {
  const keys = new Set<string>();
  const texts = doc.getXmlFragment('default').createTreeWalker((type) => type instanceof Y.XmlText);
  for (const text of texts) {
    for (const op of (text as Y.XmlText).toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
      for (const key of Object.keys(op.attributes ?? {})) keys.add(key);
    }
  }
  return [...keys].sort();
}

describe('collab schema: a room snapshot persisted before #1954', () => {
  it('was captured on bff6d4ec', () => {
    expect(COLLAB_PRE_1954.capturedAtCommit).toBe('bff6d4ec9ec3ca08642e347d19eef51059a5a4bf');
  });

  it('serialises the HTML the old schema produced for it', () => {
    expect(yDocToHtml(loadFixture())).toBe(COLLAB_PRE_1954.htmlAtCapture);
  });

  it('holds what the old schema stored: no image link attribute, the code mark under its own key', () => {
    const doc = loadFixture();
    const images = elements(doc).filter((element) => element.nodeName === 'image');
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute('href')).toBeUndefined();
      expect(image.getAttribute('linkClass')).toBeUndefined();
    }
    // The comment mark excludes nothing, so Yjs stores it under a hashed key; every other mark under its name.
    const keys = textAttributeKeys(doc);
    expect(keys.filter((key) => !key.startsWith('comment--'))).toEqual(['bold', 'code', 'italic', 'link']);
    expect(keys.some((key) => key.startsWith('comment--'))).toBe(true);
    expect(collabCarriesTaskIds(doc)).toBe(true);
  });

  it('takes a new edit and loads again from its full state', () => {
    const doc = loadFixture();
    const intro = doc.getXmlFragment('default').get(0) as Y.XmlElement;
    const text = intro.get(0) as Y.XmlText;
    text.insert(0, 'New: ');
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    expect(yDocToHtml(reloaded)).toBe(yDocToHtml(doc));
    expect(yDocToHtml(reloaded).startsWith('<p>New: Intro paragraph. Edited in a room.</p>')).toBe(true);
  });

  it('is stable when its HTML seeds a new room and that room is saved again', () => {
    // The first reseed trims leading white space in a paragraph (as before #1954); after that nothing moves.
    const once = yDocToHtml(htmlToYDoc(COLLAB_PRE_1954.htmlAtCapture));
    expect(yDocToHtml(htmlToYDoc(once))).toBe(once);
  });
});
