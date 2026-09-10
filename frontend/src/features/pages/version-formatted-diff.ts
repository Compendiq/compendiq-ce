import { diffWordsWithSpace, type Change } from 'diff';

interface AdditionRange {
  start: number;
  end: number;
}

interface DeletionPoint {
  offset: number;
  text: string;
}

interface TextNodeRange {
  node: Text;
  start: number;
  end: number;
}

/** Converts the nullable historical HTML shape into safe structural markup. */
export function versionContentAsHtml(
  bodyHtml: string | null | undefined,
  bodyText: string | null | undefined,
): string {
  if (bodyHtml) return bodyHtml;
  const document = globalThis.document.implementation.createHTMLDocument('');
  const paragraph = document.createElement('p');
  paragraph.textContent = bodyText ?? '';
  document.body.append(paragraph);
  return document.body.innerHTML;
}

/**
 * Marks a historical version's additions and removals without flattening the
 * selected version's headings, links, emphasis, or other inline structure.
 */
export function markFormattedVersionDiff(previousHtml: string, currentHtml: string): string {
  const parser = new DOMParser();
  const previousDocument = parser.parseFromString(previousHtml, 'text/html');
  const currentDocument = parser.parseFromString(currentHtml, 'text/html');
  const previousText = previousDocument.body.textContent ?? '';
  const currentText = currentDocument.body.textContent ?? '';
  const additions: AdditionRange[] = [];
  const deletions: DeletionPoint[] = [];
  let currentOffset = 0;

  for (const change of diffWordsWithSpace(previousText, currentText) as Change[]) {
    if (change.removed) {
      deletions.push({ offset: currentOffset, text: change.value });
      continue;
    }
    const end = currentOffset + change.value.length;
    if (change.added) additions.push({ start: currentOffset, end });
    currentOffset = end;
  }

  const walker = currentDocument.createTreeWalker(currentDocument.body, NodeFilter.SHOW_TEXT);
  const textNodes: TextNodeRange[] = [];
  let nodeOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    if (text.length === 0) continue;
    textNodes.push({ node: node as Text, start: nodeOffset, end: nodeOffset + text.length });
    nodeOffset += text.length;
  }

  if (textNodes.length === 0) {
    for (const deletion of deletions) {
      const element = currentDocument.createElement('del');
      element.textContent = deletion.text;
      currentDocument.body.append(element);
    }
    return currentDocument.body.innerHTML;
  }

  textNodes.forEach((range, index) => {
    const text = range.node.nodeValue ?? '';
    const isLast = index === textNodes.length - 1;
    const localAdditions = additions
      .filter((addition) => addition.start < range.end && addition.end > range.start)
      .map((addition) => ({
        start: Math.max(0, addition.start - range.start),
        end: Math.min(text.length, addition.end - range.start),
      }));
    const localDeletions = deletions
      .filter((deletion) => deletion.offset >= range.start
        && (deletion.offset < range.end || (isLast && deletion.offset === range.end)))
      .map((deletion) => ({
        offset: deletion.offset - range.start,
        text: deletion.text,
      }));
    if (localAdditions.length === 0 && localDeletions.length === 0) return;

    const boundaries = new Set<number>([0, text.length]);
    for (const addition of localAdditions) {
      boundaries.add(addition.start);
      boundaries.add(addition.end);
    }
    for (const deletion of localDeletions) boundaries.add(deletion.offset);
    const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
    const fragment = currentDocument.createDocumentFragment();

    orderedBoundaries.forEach((start, boundaryIndex) => {
      for (const deletion of localDeletions.filter((item) => item.offset === start)) {
        const element = currentDocument.createElement('del');
        element.textContent = deletion.text;
        fragment.append(element);
      }
      const end = orderedBoundaries[boundaryIndex + 1];
      if (end === undefined || end <= start) return;
      const slice = text.slice(start, end);
      const isAddition = localAdditions.some((addition) => addition.start <= start && addition.end >= end);
      if (isAddition) {
        const element = currentDocument.createElement('ins');
        element.textContent = slice;
        fragment.append(element);
      } else {
        fragment.append(currentDocument.createTextNode(slice));
      }
    });

    range.node.replaceWith(fragment);
  });

  return currentDocument.body.innerHTML;
}
