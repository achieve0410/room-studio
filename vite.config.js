import { defineConfig } from 'vite';

const allowedHosts = String(process.env.ROOM_STUDIO_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 600,
  },
  preview: {
    allowedHosts,
  },
});
