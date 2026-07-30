import {
  LoginPageVariantSchema,
  type LoginPageVariant,
} from '@compendiq/contracts';

export const LOGIN_VARIANTS = LoginPageVariantSchema.options;

export type LoginVariant = LoginPageVariant;

export const DEFAULT_LOGIN_VARIANT: LoginVariant = 'local-loop';

export function parseLoginVariant(value: string | null | undefined): LoginVariant | null {
  const parsed = LoginPageVariantSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function configuredLoginVariant(
  value: string | null | undefined = import.meta.env.VITE_LOGIN_VARIANT,
): LoginVariant {
  return parseLoginVariant(value) ?? DEFAULT_LOGIN_VARIANT;
}

export function resolveLoginVariant(
  searchParams: URLSearchParams,
  configured = configuredLoginVariant(),
): LoginVariant {
  return parseLoginVariant(searchParams.get('loginVariant')) ?? configured;
}

export function isLoginVariantPickerEnabled(
  value: string | boolean | null | undefined = import.meta.env.VITE_LOGIN_VARIANT_PICKER,
): boolean {
  return value === true || value === 'true';
}
