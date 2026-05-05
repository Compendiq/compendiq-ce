import { useState, type FormEvent } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { useAuthStore } from '../../../stores/auth-store';

interface AdminStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function AdminStep({ onNext, onBack }: AdminStepProps) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: 'Failed to create admin account' }));
        throw new Error(data.message);
      }

      const data = await res.json();
      setAuth(data.accessToken, data.user);
      toast.success('Admin account created');
      onNext();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create admin account');
    } finally {
      setLoading(false);
    }
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
    >
      <h2 className="text-xl font-semibold">Create Admin Account</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This will be the first administrator account for your Compendiq instance.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="setup-username" className="mb-1.5 block text-sm font-medium">
            Username
          </label>
          <input
            id="setup-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={50}
            className="nm-input"
            placeholder="Choose a username"
            autoComplete="username"
            data-testid="setup-username"
          />
        </div>

        <div>
          <label htmlFor="setup-password" className="mb-1.5 block text-sm font-medium">
            Password
          </label>
          <input
            id="setup-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            maxLength={128}
            className="nm-input"
            placeholder="Minimum 8 characters"
            autoComplete="new-password"
            data-testid="setup-password"
          />
        </div>

        <div>
          <label htmlFor="setup-confirm-password" className="mb-1.5 block text-sm font-medium">
            Confirm Password
          </label>
          <input
            id="setup-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            className="nm-input"
            placeholder="Re-enter your password"
            autoComplete="new-password"
            data-testid="setup-confirm-password"
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onBack}
            className="nm-icon-button px-4 py-2 text-sm"
            data-testid="admin-back-btn"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={loading}
            className="nm-button-primary px-6 py-2.5"
            data-testid="create-admin-btn"
          >
            {loading ? 'Creating...' : 'Create Account'}
          </button>
        </div>
      </form>
    </m.div>
  );
}
