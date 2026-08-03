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

/**
 * Public login-page presentation config. The selected layout is deployment
 * presentation only; it never changes authentication, registration, or SSO
 * behavior.
 */
export const LoginPageVariantSchema = z.enum(['local-loop', 'change-desk']);
export type LoginPageVariant = z.infer<typeof LoginPageVariantSchema>;

export const LoginPageConfigSchema = z.object({
  variant: LoginPageVariantSchema,
});
export type LoginPageConfig = z.infer<typeof LoginPageConfigSchema>;

/** Edition badge on the login page. The login route is unauthenticated, so it
 * cannot read `GET /api/admin/license`; the public presentation endpoint
 * reports the edition instead. */
export const AppEditionSchema = z.enum(['community', 'enterprise']);
export type AppEdition = z.infer<typeof AppEditionSchema>;

/**
 * Response shape of `GET /api/auth/login-page-config`. `edition` is *optional*
 * on purpose: an EE deployment pins the CE frontend image by tag while its
 * backend is built from an older CE release, so the SPA regularly talks to a
 * backend predating this field. A required key would throw in `.parse()` and
 * take the (unrelated) `variant` down with it — absent simply means "edition
 * unknown", and the badge is omitted rather than guessed.
 */
export const LoginPageConfigResponseSchema = LoginPageConfigSchema.extend({
  edition: AppEditionSchema.nullish(),
});
export type LoginPageConfigResponse = z.infer<typeof LoginPageConfigResponseSchema>;

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
