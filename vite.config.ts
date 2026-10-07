import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mediaServer } from './server/mediaServer';

export default defineConfig({
  plugins: [react(), mediaServer()],
});
