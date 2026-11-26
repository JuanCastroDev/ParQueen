/**
 * DEV-ONLY preview harness for the Sign Scanner. Not part of the app build (vite.config.ts only
 * builds index.html) and never deployed.
 *
 * Renders the real views/sign-scanner/SignScannerView with the real index.css + Tailwind. The
 * only substitution is services/geminiService → ./mockGeminiService, so every result and error
 * state can be reviewed without Firebase, a signed-in user, or a Gemini call.
 *
 *   npx vite --config docs/previews/sign-scanner/vite.config.ts
 */
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = __dirname;
const repoRoot = path.resolve(here, '..', '..', '..');

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^(\.\.\/)+services\/geminiService$/, replacement: path.join(here, 'mockGeminiService.ts') },
    ],
  },
  css: { postcss: repoRoot },
  server: {
    port: 5182,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: [repoRoot] },
  },
});
