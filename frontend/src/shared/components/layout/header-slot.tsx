import { type ReactNode } from 'react';

/**
 * Page heading in the document column. Chrome is navigation + session — titles
 * never portal into the 48px header.
 */
export function HeaderHost({
  children,
  fallbackClassName,
}: {
  children: ReactNode | ((portaled: boolean) => ReactNode);
  fallbackClassName?: string;
}) {
  const node = typeof children === 'function' ? children(false) : children;
  return <div className={fallbackClassName}>{node}</div>;
}
