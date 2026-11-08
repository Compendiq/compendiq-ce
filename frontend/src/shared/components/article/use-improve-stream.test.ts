import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { EditorAiContext } from '../../lib/editor-ai-context';
import { resetClientInferenceManager } from '../../lib/client-inference/client-inference-manager';
import { useImproveStream } from './use-improve-stream';

const authorized = { authorized: true, pageId: 7, aiPolicy: 'all', aiPolicyRevision: 2 };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function wrapper({ children }: { children: ReactNode }) {
  return createElement(EditorAiContext.Provider, { value: { pageId: '7', policy: 'all', revision: 2, permitted: true } }, children);
}
afterEach(() => { cleanup(); resetClientInferenceManager(); vi.restoreAllMocks(); });

describe('article-bound selection rewrite', () => {
  it('refuses unknown policy without dispatching content', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useImproveStream());
    await act(async () => result.current.run('private passage', 'grammar'));
    expect(result.current.status).toBe('error');
    expect(result.current.output).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('carries article identity and publishes only a completed, rechecked preview', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('browser-authorization')) return json(authorized);
      if (String(url).includes('/client-inference/policy')) return json({ active: false, mode: 'allowed' });
      requests.push(JSON.parse(String(init?.body)));
      return new Response('data: {"content":"Corrected passage","done":true}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const { result } = renderHook(() => useImproveStream(), { wrapper });
    await act(async () => result.current.run('teh passage', 'grammar'));
    expect(requests).toEqual([expect.objectContaining({ pageId: '7', content: 'teh passage' })]);
    expect(result.current.status).toBe('done');
    expect(result.current.output).toBe('Corrected passage');
    act(() => window.dispatchEvent(new Event('offline')));
    expect(result.current.output).toBe('');
  });

  it('rejects a changed revision and never sends the selection', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ ...authorized, aiPolicyRevision: 3 }));
    const { result } = renderHook(() => useImproveStream(), { wrapper });
    await act(async () => result.current.run('private passage', 'grammar'));
    expect(result.current.status).toBe('error');
    expect(fetch.mock.calls.every(([url]) => String(url).includes('browser-authorization'))).toBe(true);
  });

  it('keeps incomplete output ineligible for application', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('browser-authorization')) return json(authorized);
      if (String(url).includes('/client-inference/policy')) return json({ active: false, mode: 'allowed' });
      return new Response('data: {"content":"partial"}\n\n');
    });
    const { result } = renderHook(() => useImproveStream(), { wrapper });
    await act(async () => result.current.run('passage', 'clarity'));
    expect(result.current.status).toBe('error');
    expect(result.current.output).toBe('');
    expect(result.current.error).toMatch(/interrupted/);
  });
});
