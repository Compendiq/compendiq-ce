/* eslint-disable react-refresh/only-export-components */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { App } from './App';
import { useThemeStore, isLightTheme } from './stores/theme-store';
import { createQueryClient } from './shared/lib/query-client';
import './index.css';

const queryClient = createQueryClient();

function ThemedToaster() {
  const theme = useThemeStore((s) => s.theme);
  return (
    <Toaster
      position="bottom-right"
      richColors
      theme={isLightTheme(theme) ? 'light' : 'dark'}
      toastOptions={{
        className: 'backdrop-blur-md bg-card/80 border border-border/50',
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ThemedToaster />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
