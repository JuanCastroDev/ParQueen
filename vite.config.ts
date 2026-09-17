/// <reference types="vitest" />
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { resolveAppRelease, hasSentryUploadConfig } from './sentryRelease';
import {
  applyProductionBuildConfigGuard,
  resolveViteEnvDir,
} from './productionBuildConfig';

export default defineConfig(({ command, mode }) => {
    // Third argument '' loads every env var regardless of VITE_ prefix — Vite
    // only auto-exposes VITE_-prefixed vars to client code (import.meta.env)
    // on its own; this is purely so this Node-side config can read the
    // build-only Sentry credentials (SENTRY_AUTH_TOKEN/ORG/PROJECT), which
    // must never reach the client bundle or `define`.
    //
    // Env-dir isolation is test-only: both PARQUEEN_CONFIG_CONTRACT_TEST=1 and
    // PARQUEEN_VITE_ENV_DIR must be set. Ordinary release builds ignore them.
    // Neither name is VITE_-prefixed, so Vite does not expose them to the client.
    const envDir = resolveViteEnvDir();
    const env = loadEnv(mode, envDir, '');
    applyProductionBuildConfigGuard(command, env);
    const release = resolveAppRelease(env);
    const uploadConfigPresent = hasSentryUploadConfig(env);

    return {
      envDir,
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        // Only active when real upload credentials are present — an ordinary
        // local/CI build without them must still succeed, just without
        // source-map generation/upload (see build.sourcemap below).
        ...(uploadConfigPresent ? [sentryVitePlugin({
          org: env.SENTRY_ORG,
          project: env.SENTRY_PROJECT,
          authToken: env.SENTRY_AUTH_TOKEN,
          release: { name: release },
          telemetry: false,
          sourcemaps: {
            // Maps are only ever generated (build.sourcemap: 'hidden') when
            // this plugin is active, so this glob only ever matches maps
            // produced for this exact upload — never leaves them in dist/.
            filesToDeleteAfterUpload: ['./dist/**/*.map'],
          },
        })] : []),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      define: {
        __APP_RELEASE__: JSON.stringify(release),
      },
      build: {
        // 'hidden' generates maps (for the plugin to upload) without adding a
        // //# sourceMappingURL= comment to the shipped JS, so browsers never
        // discover them — and they're deleted from dist/ after upload above.
        // Without upload credentials, no maps are generated at all.
        sourcemap: uploadConfigPresent ? 'hidden' : false,
        // Vite 8 minifies CSS with lightningcss by default, which prunes vendor
        // prefixes it judges redundant for its browser targets. That silently
        // dropped the unprefixed `backdrop-filter` from .glass-panel,
        // .glass-button and the map search/status/control shells, keeping only
        // -webkit-. Chrome and Safari accept the -webkit- form, but Firefox
        // supports ONLY the unprefixed property, so the glass blur disappeared
        // there. index.css hand-writes both variants on purpose; esbuild
        // preserves authored declarations verbatim, which is what Vite 5 did.
        cssMinify: 'esbuild',
      },
      test: {
        environment: 'node',
        globals: true,
        exclude: ['**/node_modules/**', 'firestore.rules.test.ts', 'storage.rules.test.ts', 'functions/*.integration.test.*'],
      },
    };
});
