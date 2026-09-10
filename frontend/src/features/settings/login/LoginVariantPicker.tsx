import type { LoginVariant } from './login-variant';

interface LoginVariantPickerProps {
  value: LoginVariant;
  onChange: (variant: LoginVariant) => void;
}

export function LoginVariantPicker({ value, onChange }: LoginVariantPickerProps) {
  return (
    <div
      className="inline-flex rounded-lg border border-border-interactive bg-card p-1"
      aria-label="Login page design"
      role="group"
    >
      <button
        type="button"
        onClick={() => onChange('local-loop')}
        aria-pressed={value === 'local-loop'}
        className="min-h-9 rounded-md px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground"
      >
        Local Loop
      </button>
      <button
        type="button"
        onClick={() => onChange('change-desk')}
        aria-pressed={value === 'change-desk'}
        className="min-h-9 rounded-md px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground"
      >
        Change Desk
      </button>
    </div>
  );
}
