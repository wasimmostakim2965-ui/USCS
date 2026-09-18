import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: process.env.VERCEL
      ? {
          '@appdeploy/client': new URL('./src/appdeploy-vercel-shim.ts', import.meta.url).pathname,
        }
      : {},
  },
});
