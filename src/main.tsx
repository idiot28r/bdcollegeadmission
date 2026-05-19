import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './App.tsx'

// Sentry only initializes if a DSN is configured. Put VITE_SENTRY_DSN in
// .env (and in Vercel's project env vars) once you've created a Sentry
// project. Empty/missing DSN = silently no-op, no perf cost in dev.
const dsn = import.meta.env.VITE_SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Errors only — keep traces/replays off for free-tier cost control.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
