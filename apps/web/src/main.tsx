import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { initTheme } from './ui/theme';
import './ui/tokens.css';
import './ui/base.css';
import './ui/ui.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (window.parent === window) registerSW({ immediate: true });
