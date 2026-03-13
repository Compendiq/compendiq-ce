import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// --- Mocks must be declared before the dynamic import ---

const mockRefreshAccessTokenOnce = vi.fn();

vi.mock('../lib/api', () => ({
  refreshAccessTokenOnce: mockRefreshAccessTokenOnce,
}));

vi.mock('jose', () => ({
  decodeJwt: vi.fn(),
}));

let accessTokenState: string | null = null;

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: { accessToken: string | null }) => unknown) =>
    selector({ accessToken: accessTokenState }),
}));

// Dynamic import after mocks are wired up
const { useTokenRefreshTimer } = await import('./useTokenRefreshTimer');
const { decodeJwt } = await import('jose');
const mockedDecodeJwt = vi.mocked(decodeJwt);

describe('useTokenRefreshTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRefreshAccessTokenOnce.mockResolvedValue('new-token');
    mockRefreshAccessTokenOnce.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    accessTokenState = null;
  });

  it('schedules a refresh timer at 75% of remaining token lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 900; // 900 seconds remaining
    // 75% of 900 = 675 seconds = 675_000 ms

    accessTokenState = 'valid.token.here';
    mockedDecodeJwt.mockReturnValue({ exp } as ReturnType<typeof decodeJwt>);

    renderHook(() => useTokenRefreshTimer());

    // Not called yet
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();

    // Advance to just before refresh time — should not fire yet
    vi.advanceTimersByTime(674_999);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();

    // Advance to the refresh time
    vi.advanceTimersByTime(1);
    expect(mockRefreshAccessTokenOnce).toHaveBeenCalledTimes(1);
  });

  it('uses a minimum delay of 10 seconds for nearly-expired tokens', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 5; // only 5 seconds remaining — 75% = 3.75s, floored to 10s minimum

    accessTokenState = 'nearly.expired.token';
    mockedDecodeJwt.mockReturnValue({ exp } as ReturnType<typeof decodeJwt>);

    renderHook(() => useTokenRefreshTimer());

    // Should not fire at 9 seconds
    vi.advanceTimersByTime(9_999);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();

    // Should fire at 10 seconds
    vi.advanceTimersByTime(1);
    expect(mockRefreshAccessTokenOnce).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a timer when accessToken is null', () => {
    accessTokenState = null;

    renderHook(() => useTokenRefreshTimer());

    vi.advanceTimersByTime(60_000);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('clears the timer on unmount', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 900;

    accessTokenState = 'valid.token.here';
    mockedDecodeJwt.mockReturnValue({ exp } as ReturnType<typeof decodeJwt>);

    const { unmount } = renderHook(() => useTokenRefreshTimer());

    // Unmount before the timer fires
    unmount();

    vi.advanceTimersByTime(900_000);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('does not schedule a timer for an already-expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now - 60; // expired 60 seconds ago

    accessTokenState = 'expired.token.here';
    mockedDecodeJwt.mockReturnValue({ exp } as ReturnType<typeof decodeJwt>);

    renderHook(() => useTokenRefreshTimer());

    vi.advanceTimersByTime(60_000);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('does not schedule a timer when token has no exp claim', () => {
    accessTokenState = 'no.exp.token';
    mockedDecodeJwt.mockReturnValue({} as ReturnType<typeof decodeJwt>);

    renderHook(() => useTokenRefreshTimer());

    vi.advanceTimersByTime(60_000);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('does not schedule a timer when decodeJwt throws (malformed token)', () => {
    accessTokenState = 'malformed-token';
    mockedDecodeJwt.mockImplementation(() => {
      throw new Error('Invalid JWT');
    });

    renderHook(() => useTokenRefreshTimer());

    vi.advanceTimersByTime(60_000);
    expect(mockRefreshAccessTokenOnce).not.toHaveBeenCalled();
  });

  it('silently swallows proactive refresh failures', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 100;

    accessTokenState = 'valid.token.here';
    mockedDecodeJwt.mockReturnValue({ exp } as ReturnType<typeof decodeJwt>);
    mockRefreshAccessTokenOnce.mockRejectedValue(new Error('Network error'));

    renderHook(() => useTokenRefreshTimer());

    // Timer fires and rejects — should not throw an unhandled rejection
    expect(() => vi.advanceTimersByTime(100_000)).not.toThrow();
    expect(mockRefreshAccessTokenOnce).toHaveBeenCalledTimes(1);
  });
});
