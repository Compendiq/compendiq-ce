export interface DraftNote {
  id: string;
  body: string;
  authorName?: string;
  createdAt: string;
  anchorData?: {
    quote?: string;
    text?: string;
    from?: number;
    to?: number;
  };
  resolved?: boolean;
}

const draftNotesMap = new Map<string, DraftNote>();

export function setDraftNote(id: string, note: DraftNote): void {
  draftNotesMap.set(id, note);
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(`compendiq:draft-note:${id}`, JSON.stringify(note));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function getDraftNote(id: string): DraftNote | undefined {
  if (draftNotesMap.has(id)) {
    return draftNotesMap.get(id);
  }
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const item = window.sessionStorage.getItem(`compendiq:draft-note:${id}`);
      if (item) {
        const parsed = JSON.parse(item) as DraftNote;
        draftNotesMap.set(id, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore parsing errors
  }
  return undefined;
}

export function deleteDraftNote(id: string): void {
  draftNotesMap.delete(id);
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(`compendiq:draft-note:${id}`);
    }
  } catch {
    // ignore
  }
}
