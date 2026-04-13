import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { StreamingCursor } from '../../shared/components/feedback/StreamingCursor';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';

interface StreamingMessageProps {
  /** The current streaming content to render. */
  content: string;
  /** Whether the stream is still active (shows cursor). */
  isStreaming: boolean;
  className?: string;
}

/**
 * Renders streaming AI content with Markdown formatting and a blinking cursor.
 *
 * This component is designed to receive batched content updates from
 * `useStreamingContent` rather than per-token updates, significantly
 * reducing the number of Markdown re-parses during streaming.
 */
export function StreamingMessage({ content, isStreaming, className }: StreamingMessageProps) {
  const isLight = useIsLightTheme();

  return (
    <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert', className)} data-testid="streaming-message">
      {content ? (
        <>
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          {isStreaming && <StreamingCursor />}
        </>
      ) : null}
    </div>
  );
}
