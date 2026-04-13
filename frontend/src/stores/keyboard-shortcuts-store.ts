import { create } from 'zustand';

interface KeyboardShortcutsState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Currently pending sequence prefix (e.g. 'g') or null when idle. */
  pendingSequence: string | null;
  setPendingSequence: (seq: string | null) => void;
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  pendingSequence: null,
  setPendingSequence: (seq) => set({ pendingSequence: seq }),
}));
