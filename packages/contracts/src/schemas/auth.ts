import { z } from 'zod';

export const RegisterSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(128),
  email: z.string().email().optional(),
  displayName: z.string().min(1).max(200).optional(),
});

export const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const AuthResponseSchema = z.object({
  accessToken: z.string(),
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    role: z.enum(['user', 'admin']),
    email: z.string().email().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }),
});

/**
 * Public registration policy (#1051). Returned by the unauthenticated
 * `GET /api/auth/registration-policy` so the SPA knows whether to render the
 * self-service signup toggle. Deliberately minimal — it exposes only the
 * boolean the login page needs, never the underlying `open`/`closed` mode nor
 * any hint about how many admins exist. The frontend fails **closed**: any
 * parse/fetch error leaves signup hidden.
 */
export const RegistrationPolicySchema = z.object({
  allowRegistration: z.boolean(),
});
export type RegistrationPolicy = z.infer<typeof RegistrationPolicySchema>;

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
