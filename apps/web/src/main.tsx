import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { ViewBoundary } from './ui/guarded';
import { initTheme } from './ui/theme';
import './ui/tokens.css';
import './ui/base.css';
import './ui/ui.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewBoundary title="AfterLink">
      <App />
    </ViewBoundary>
  </StrictMode>,
);

/** A new version waits for the next cold start: a device mid-mission is never reloaded under its user. */
if (window.parent === window) registerSW({ immediate: true });
