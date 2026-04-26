import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

// Build metadata. Committed placeholder lives at <repo root>/build-info.json
// and is overwritten by scripts/build-enterprise.sh during EE builds with
// the real CE + EE commit hashes. If the file is missing (fresh dev
// checkout, for example), fall back to defaults so the build doesn't fail.
interface BuildInfo {
  edition: string;
  commit: string;
  builtAt: string;
}
let buildInfo: BuildInfo = { edition: 'community', commit: 'unknown', builtAt: '' };
try {
  buildInfo = JSON.parse(
    readFileSync(path.resolve(__dirname, '../build-info.json'), 'utf-8'),
  );
} catch {
  // Use defaults; nothing to log since this runs during vite config init.
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __APP_COMMIT__: JSON.stringify(buildInfo.commit),
    __APP_EDITION__: JSON.stringify(buildInfo.edition),
    __APP_BUILT_AT__: JSON.stringify(buildInfo.builtAt),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 8081,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3051',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query': ['@tanstack/react-query'],
          'motion': ['framer-motion'],
          'radix-ui': [
            '@radix-ui/react-collapsible',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-switch',
          ],
          'ui-utils': [
            'lucide-react',
            'clsx',
            'tailwind-merge',
            'sonner',
          ],
          'zustand': ['zustand'],
          'recharts': ['recharts'],
          'pdf': ['pdf-lib'],
          // The excel chunk was removed in #303 alongside the exceljs dep.
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
