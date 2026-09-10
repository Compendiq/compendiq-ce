import type { LucideProps } from 'lucide-react';

/**
 * SkillsIcon: Custom SVG icon representing AI skills, capabilities, and actions
 * (knowledge Q&A, rewrite skills, document generation, and diagrams).
 *
 * Designed on a 24x24 grid matching Lucide stroke and viewBox conventions.
 */
export function SkillsIcon({
  size = 16,
  strokeWidth = 2,
  className,
  ...props
}: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
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
      {/* Central 4-point skill spark */}
      <path d="M12 2C12 7.2 7.2 12 2 12C7.2 12 12 16.8 12 22C12 16.8 16.8 12 22 12C16.8 12 12 7.2 12 2Z" />
      {/* Top-right capability spark */}
      <path d="M19 2v4" />
      <path d="M17 4h4" />
      {/* Bottom-left capability node */}
      <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
