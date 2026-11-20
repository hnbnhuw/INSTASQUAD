import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite (5173) proxy /api sang backend (4000) ⇒ cùng origin, cookie SameSite hoạt động, không cần CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
});
