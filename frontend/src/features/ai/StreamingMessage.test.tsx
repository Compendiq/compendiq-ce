import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { StreamingMessage } from './StreamingMessage';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

describe('StreamingMessage', () => {
  it('renders markdown content', () => {
    render(
      <StreamingMessage content="Hello **world**" isStreaming={false} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('world')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
  });

  it('shows streaming cursor when isStreaming is true', () => {
    render(
      <StreamingMessage content="Streaming text" isStreaming />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
  });

  it('hides streaming cursor when isStreaming is false', () => {
    render(
      <StreamingMessage content="Done text" isStreaming={false} />,
      { wrapper: Wrapper },
    );

    expect(screen.queryByTestId('streaming-cursor')).not.toBeInTheDocument();
  });

  it('renders nothing when content is empty', () => {
    render(
      <StreamingMessage content="" isStreaming />,
      { wrapper: Wrapper },
    );

    const container = screen.getByTestId('streaming-message');
    // Should have no children when content is empty
    expect(container.children).toHaveLength(0);
  });

  it('renders GFM markdown features (tables, strikethrough)', () => {
    const markdown = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |';
    render(
      <StreamingMessage content={markdown} isStreaming={false} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Col A')).toBeInTheDocument();
    expect(screen.getByText('Col B')).toBeInTheDocument();
  });

  it('applies prose styling classes', () => {
    render(
      <StreamingMessage content="Styled content" isStreaming={false} />,
      { wrapper: Wrapper },
    );

    const container = screen.getByTestId('streaming-message');
    expect(container.className).toContain('prose');
    expect(container.className).toContain('prose-sm');
  });
});
