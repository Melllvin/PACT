import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppStore } from './store/app-store';
import './theme/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App
      store={createAppStore(window.pact)}
      getPathForFile={(file) => window.pact.pathForFile(file)}
    />
  </StrictMode>,
);
