// VBK Desktop — renderer bootstrap
// Detect window.vbk (preload) and fall back to the local demo API so the UI
// remains usable in plain Vite dev mode. Mounts <App />.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('VBK Desktop: #root element not found');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
