// Must stay first: it configures zod before any schema is created.
import './lib/zodConfig';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { RuntimeProvider } from './runtime/RuntimeProvider';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RuntimeProvider>
          <App />
        </RuntimeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
