import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'destructive-ghost'
  | 'ai';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  'data-testid'?: string;
  testid?: string;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground border-transparent hover:bg-[color-mix(in_oklab,var(--color-primary)_88%,var(--color-foreground))] active:bg-[color-mix(in_oklab,var(--color-primary)_78%,var(--color-foreground))] focus-visible:outline-ring',
  secondary:
    'border-transparent bg-transparent text-foreground hover:bg-accent active:bg-secondary focus-visible:outline-ring',
  ghost:
    'border-transparent bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent active:bg-secondary focus-visible:outline-ring',
  destructive:
    'bg-destructive text-destructive-foreground border-transparent hover:bg-[color-mix(in_oklab,var(--color-destructive)_86%,var(--color-foreground))] active:bg-[color-mix(in_oklab,var(--color-destructive)_74%,var(--color-foreground))] focus-visible:outline-destructive',
  'destructive-ghost':
    'border-transparent bg-transparent text-destructive hover:bg-destructive/10 active:bg-destructive/15 focus-visible:outline-destructive',
  ai:
    'border-transparent bg-status-ai/10 text-status-ai hover:bg-status-ai/20 active:bg-status-ai/25 focus-visible:outline-status-ai',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-[var(--radius-md)]',
  lg: 'h-10 px-4 text-sm gap-2 rounded-[var(--radius-md)]',
  icon: 'h-8 w-8 p-0 justify-center rounded-[var(--radius-md)]',
  'icon-sm': 'h-7 w-7 p-0 justify-center rounded-[var(--radius-sm)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'secondary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      className,
      disabled,
      testid,
      'data-testid': dataTestId,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const isIconSize = size === 'icon' || size === 'icon-sm';
    const loaderSize = size === 'sm' || size === 'icon-sm' ? 13 : size === 'lg' ? 16 : 14;

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        aria-busy={isLoading ? 'true' : undefined}
        data-testid={testid ?? dataTestId}
        className={cn(
          'relative inline-flex items-center justify-center font-medium select-none cursor-pointer border border-solid transition-colors duration-100 ease-out outline-2 outline-offset-2 outline-transparent disabled:opacity-45 disabled:pointer-events-none disabled:cursor-not-allowed',
          variantStyles[variant],
          sizeStyles[size],
          isLoading && 'pointer-events-none',
          className,
        )}
        {...props}
      >
        {isIconSize ? (
          isLoading ? <Loader2 size={loaderSize} className="animate-spin shrink-0" /> : children
        ) : (
          <>
            {isLoading ? (
              <Loader2 size={loaderSize} className="animate-spin shrink-0" />
            ) : (
              leftIcon && <span className="shrink-0 inline-flex items-center">{leftIcon}</span>
            )}
            {children}
            {!isLoading && rightIcon && (
              <span className="shrink-0 inline-flex items-center">{rightIcon}</span>
            )}
          </>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonProps, 'leftIcon' | 'rightIcon' | 'children'> {
  icon: React.ReactNode;
  'aria-label'?: string;
  label?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, size = 'icon', variant = 'ghost', label, 'aria-label': ariaLabel, ...props }, ref) => {
    const computedSize = size === 'sm' || size === 'icon-sm' ? 'icon-sm' : 'icon';
    return (
      <Button
        ref={ref}
        variant={variant}
        size={computedSize}
        aria-label={label ?? ariaLabel}
        {...props}
      >
        {icon}
      </Button>
    );
  },
);

IconButton.displayName = 'IconButton';
