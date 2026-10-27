import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SessionProvider } from './state/session';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('Elemen #root tidak ditemukan');
createRoot(el).render(
  <React.StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </React.StrictMode>
);
