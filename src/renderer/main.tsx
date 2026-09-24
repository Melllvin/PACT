import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppStore } from './store/app-store';
import { createTerminalRegistry } from './tiles/terminal-registry';
import { createXterm } from './tiles/xterm-factory';
import './theme/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// Outside React: StrictMode would otherwise subscribe twice and print every output twice.
const terminals = createTerminalRegistry(window.pact, () => createXterm());

createRoot(root).render(
  <StrictMode>
    <App
      store={createAppStore(window.pact)}
      getPathForFile={(file) => window.pact.pathForFile(file)}
      terminals={terminals}
    />
  </StrictMode>,
);
