/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOGIN_VARIANT?: 'local-loop' | 'change-desk';
  readonly VITE_LOGIN_VARIANT_PICKER?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_EDITION__: string;
declare const __APP_BUILT_AT__: string;
