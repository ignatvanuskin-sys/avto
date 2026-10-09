import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@/styles/globals.css';
import { App } from '@/App';
import { TenantThemeProvider, readBootPayload } from '@/tenant/TenantProvider';
import { registerStudioServiceWorker } from '@/pwa/register';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A booking screen must never show a stale free slot as available.
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const boot = readBootPayload();

registerStudioServiceWorker();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from the HTML shell.');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TenantThemeProvider
        slug={boot?.slug ?? null}
        accent={boot?.accentColor ?? '#ff6a00'}
        accentForeground={boot?.accentForeground ?? '#0b0b0c'}
      >
        <BrowserRouter basename={boot?.basePath ?? '/'}>
          <App />
        </BrowserRouter>
      </TenantThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
