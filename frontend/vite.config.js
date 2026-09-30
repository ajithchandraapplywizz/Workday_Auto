import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5180;

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});

