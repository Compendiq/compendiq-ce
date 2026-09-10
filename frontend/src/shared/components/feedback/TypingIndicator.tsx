import { cn } from '../../lib/cn';

interface TypingIndicatorProps {
  /**
   * Tint for the dots. Defaults to steel; the docked assistant passes the
   * violet AI token, because in the dock the dots are the only thing on screen
   * saying an AI is at work (ADR-010 v0.5).
   */
  dotClassName?: string;
  /** Distinguishes the two mount points for tests. */
  testId?: string;
  label?: string;
}

/**
 * Three dots with a staggered rise — the first two seconds of a stream, before
 * AIThinkingBlob takes over. Shared by `/ai` and the dock so both surfaces
 * wait in the same visual language.
 */
export function TypingIndicator({
  dotClassName = 'bg-primary/60',
  testId = 'typing-indicator',
  label = 'AI is typing',
}: TypingIndicatorProps) {
  return (
    <div className="flex items-center gap-1" data-testid={testId} aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn('h-1.5 w-1.5 rounded-full', dotClassName)}
          style={{
            // `typing-bounce` (index.css) is a 4px rise on an ease-in-out
            // cycle, not a bounce/elastic easing curve — the name is about the
            // shape of a typing indicator, which is the one place a repeating
            // rise is the established idiom rather than decoration.
            animation: 'typing-bounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}
