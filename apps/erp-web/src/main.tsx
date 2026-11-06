import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './estilos.css';
import { configurarZodPtBr } from '@genesis/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

configurarZodPtBr();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
