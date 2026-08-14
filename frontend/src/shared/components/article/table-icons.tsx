import React from 'react';

export interface TableIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

/**
 * Table grid with prominent external + above (Add row above).
 * Generous spacing between the + glyph and the table body.
 */
export function IconInsertRowAbove({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Large prominent + symbol on top with generous breathing room */}
      <line x1="12" y1="1" x2="12" y2="7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="9" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      {/* Base table grid below */}
      <rect x="3" y="11.5" width="18" height="10" rx="1.5" strokeWidth={strokeWidth} />
      <line x1="3" y1="16.5" x2="21" y2="16.5" strokeWidth="1.5" />
      <line x1="12" y1="11.5" x2="12" y2="21.5" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Table grid with prominent external + below (Add row below).
 * Generous spacing between the + glyph and the table body.
 */
export function IconInsertRowBelow({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Base table grid on top */}
      <rect x="3" y="2.5" width="18" height="10" rx="1.5" strokeWidth={strokeWidth} />
      <line x1="3" y1="7.5" x2="21" y2="7.5" strokeWidth="1.5" />
      <line x1="12" y1="2.5" x2="12" y2="12.5" strokeWidth="1.5" />
      {/* Large prominent + symbol on bottom with generous breathing room */}
      <line x1="12" y1="17" x2="12" y2="23" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="9" y1="20" x2="15" y2="20" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Table grid with prominent middle deletion minus (Delete row).
 */
export function IconDeleteRow({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={strokeWidth} />
      <line x1="3" y1="9" x2="21" y2="9" strokeWidth="1.5" />
      <line x1="3" y1="15" x2="21" y2="15" strokeWidth="1.5" />
      <line x1="12" y1="3" x2="12" y2="21" strokeWidth="1.5" />
      {/* Middle row deletion indicator */}
      <rect x="3" y="9" width="18" height="6" fill="currentColor" fillOpacity="0.25" />
      <line x1="6.5" y1="12" x2="17.5" y2="12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Table grid with prominent external + on left (Add column before).
 * Generous spacing between the + glyph and the table body.
 */
export function IconInsertColumnBefore({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Large prominent + symbol on left with generous breathing room */}
      <line x1="4" y1="9" x2="4" y2="15" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="1" y1="12" x2="7" y2="12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      {/* Base table grid to the right */}
      <rect x="11.5" y="3" width="10" height="18" rx="1.5" strokeWidth={strokeWidth} />
      <line x1="11.5" y1="12" x2="21.5" y2="12" strokeWidth="1.5" />
      <line x1="16.5" y1="3" x2="16.5" y2="21" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Table grid with prominent external + on right (Add column after).
 * Generous spacing between the + glyph and the table body.
 */
export function IconInsertColumnAfter({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Base table grid to the left */}
      <rect x="2.5" y="3" width="10" height="18" rx="1.5" strokeWidth={strokeWidth} />
      <line x1="2.5" y1="12" x2="12.5" y2="12" strokeWidth="1.5" />
      <line x1="7.5" y1="3" x2="7.5" y2="21" strokeWidth="1.5" />
      {/* Large prominent + symbol on right with generous breathing room */}
      <line x1="20" y1="9" x2="20" y2="15" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="17" y1="12" x2="23" y2="12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Table grid with prominent middle column deletion minus (Delete column).
 */
export function IconDeleteColumn({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={strokeWidth} />
      <line x1="9" y1="3" x2="9" y2="21" strokeWidth="1.5" />
      <line x1="15" y1="3" x2="15" y2="21" strokeWidth="1.5" />
      <line x1="3" y1="12" x2="21" y2="12" strokeWidth="1.5" />
      {/* Middle column deletion indicator */}
      <rect x="9" y="3" width="6" height="18" fill="currentColor" fillOpacity="0.25" />
      <line x1="12" y1="6.5" x2="12" y2="17.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

/** Table grid with highlighted top header row */
export function IconHeaderRow({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={strokeWidth} />
      <rect x="3" y="3" width="18" height="6" rx="1.5" fill="currentColor" fillOpacity="0.38" strokeWidth={strokeWidth} />
      <line x1="3" y1="15" x2="21" y2="15" strokeWidth="1.5" />
      <line x1="12" y1="9" x2="12" y2="21" strokeWidth="1.5" />
    </svg>
  );
}

/** Table grid with highlighted left header column */
export function IconHeaderColumn({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={strokeWidth} />
      <rect x="3" y="3" width="6" height="18" rx="1.5" fill="currentColor" fillOpacity="0.38" strokeWidth={strokeWidth} />
      <line x1="15" y1="3" x2="15" y2="21" strokeWidth="1.5" />
      <line x1="9" y1="12" x2="21" y2="12" strokeWidth="1.5" />
    </svg>
  );
}

/** Table grid with caption text lines placed below */
export function IconTableCaption({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: TableIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="11" rx="1.5" strokeWidth={strokeWidth} />
      <line x1="3" y1="8.5" x2="21" y2="8.5" strokeWidth="1.5" />
      <line x1="12" y1="3" x2="12" y2="14" strokeWidth="1.5" />
      <line x1="3" y1="18" x2="14" y2="18" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="3" y1="21.5" x2="8" y2="21.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}
