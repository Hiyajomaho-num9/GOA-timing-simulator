import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'chrome89',
    outDir: 'web-dist',
    emptyOutDir: true,
  },
});
