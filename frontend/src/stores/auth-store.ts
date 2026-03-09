import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setAuth: (accessToken: string, user: User) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      setAuth: (accessToken, user) =>
        set({ accessToken, user, isAuthenticated: true }),
      clearAuth: () =>
        set({ accessToken: null, user: null, isAuthenticated: false }),
    }),
    {
      name: 'kb-auth',
      partialize: (state) => ({
        // Persist token so new tabs have it immediately without refresh races
        accessToken: state.accessToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

/**
 * Sync auth state across browser tabs via the storage event.
 * When one tab logs out (clears localStorage), other tabs detect
 * the change and clear their in-memory auth state immediately.
 * When one tab refreshes the token, other tabs pick up the new token.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'kb-auth') return;

    if (event.newValue === null) {
      // localStorage was cleared (logout in another tab)
      useAuthStore.getState().clearAuth();
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue);
      const synced = parsed?.state;
      if (!synced) return;

      if (!synced.isAuthenticated) {
        // Other tab logged out
        useAuthStore.getState().clearAuth();
      } else if (synced.accessToken && synced.user) {
        // Other tab refreshed the token — pick up the new one
        useAuthStore.getState().setAuth(synced.accessToken, synced.user);
      }
    } catch {
      // Malformed JSON — ignore
    }
  });
}
