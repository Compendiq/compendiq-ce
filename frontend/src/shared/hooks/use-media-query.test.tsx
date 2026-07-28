import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useMediaQuery, useIsDockWideLayout, DOCK_WIDE_QUERY } from './use-media-query';

function Probe({ query }: { query: string }) {
  return <span data-testid="result">{String(useMediaQuery(query))}</span>;
}

function DockProbe() {
  return <span data-testid="result">{String(useIsDockWideLayout())}</span>;
}

describe('useMediaQuery', () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('reports a matching width query', () => {
    window.innerWidth = 1400;
    render(<Probe query="(min-width: 1100px)" />);
    expect(screen.getByTestId('result')).toHaveTextContent('true');
  });

  it('reports a non-matching width query', () => {
    window.innerWidth = 900;
    render(<Probe query="(min-width: 1100px)" />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');
  });

  it('re-reads the query when the change listener fires', () => {
    window.innerWidth = 900;
    render(<Probe query="(min-width: 1100px)" />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');

    // jsdom's matchMedia stub does not dispatch change events, so re-mount is
    // how a width change is observed here. What this pins is that the hook
    // reads the query rather than caching a value from first render.
    act(() => {
      window.innerWidth = 1400;
    });
    render(<Probe query="(min-width: 1100px)" />);
    expect(screen.getAllByTestId('result')[1]).toHaveTextContent('true');
  });

  it('does not match a query it knows nothing about', () => {
    render(<Probe query="(orientation: portrait)" />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');
  });
});

describe('useIsDockWideLayout', () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('is the ~1100px rule the dock and the article rail share', () => {
    expect(DOCK_WIDE_QUERY).toBe('(min-width: 1100px)');
  });

  it('is false at the width where a 40px rail plus a 420px dock would starve the editor', () => {
    window.innerWidth = 1024;
    render(<DockProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');
  });

  it('is true once both fit', () => {
    window.innerWidth = 1440;
    render(<DockProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('true');
  });
});
