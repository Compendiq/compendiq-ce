import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  useMediaQuery,
  useIsDockWideLayout,
  useIsMobileLayout,
  useIsInspectorWideLayout,
  DOCK_WIDE_QUERY,
  MD_QUERY,
  INSPECTOR_WIDE_QUERY,
} from './use-media-query';

function Probe({ query }: { query: string }) {
  return <span data-testid="result">{String(useMediaQuery(query))}</span>;
}

function DockProbe() {
  return <span data-testid="result">{String(useIsDockWideLayout())}</span>;
}

function MobileProbe() {
  return <span data-testid="result">{String(useIsMobileLayout())}</span>;
}

function InspectorWideProbe() {
  return <span data-testid="result">{String(useIsInspectorWideLayout())}</span>;
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

describe('useIsInspectorWideLayout', () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('is the xl rule the expanded inspector defaults on', () => {
    expect(INSPECTOR_WIDE_QUERY).toBe('(min-width: 1280px)');
  });

  it('is false at laptop width so the inspector starts collapsed', () => {
    window.innerWidth = 1024;
    render(<InspectorWideProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');
  });

  it('is true at 1280px', () => {
    window.innerWidth = 1280;
    render(<InspectorWideProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('true');
  });
});

describe('useIsMobileLayout', () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('is Tailwind’s md breakpoint, as a min-width query', () => {
    expect(MD_QUERY).toBe('(min-width: 768px)');
  });

  it('is true on a phone, where there is no right pane to dock into', () => {
    window.innerWidth = 390;
    render(<MobileProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('true');
  });

  // The boundary is where a `md:` class would switch, not one pixel either
  // side of it: 768 is desktop for Tailwind and must be desktop here too.
  it('is false at exactly 768px, matching what a md: utility does', () => {
    window.innerWidth = 768;
    render(<MobileProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('false');
  });

  it('is true one pixel below the breakpoint', () => {
    window.innerWidth = 767;
    render(<MobileProbe />);
    expect(screen.getByTestId('result')).toHaveTextContent('true');
  });
});
