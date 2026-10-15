import { createPostHogDirectTransport, type DirectAnalyticsDependencies } from './posthogDirectTransport';
import type { ProductAnalyticsEvent } from './productAnalyticsEvents';

interface RuntimeOptions {
  enabled: boolean;
  projectToken?: string;
  sendRequest?: DirectAnalyticsDependencies['sendRequest'];
}

const NOOP_RUNTIME = {
  capture: (_event: unknown): boolean => false,
  dispose: (): void => {},
};

/** No subscription or HTTP traffic when disabled or unconfigured. */
export function createProductAnalyticsRuntime(options: RuntimeOptions) {
  const token = options.projectToken?.trim();
  if (!options.enabled || !token || /\s/.test(token) || token.length > 256) {
    return NOOP_RUNTIME;
  }
  return createPostHogDirectTransport({
    projectToken: token,
    sendRequest: options.sendRequest,
  });
}

let runtime: ReturnType<typeof createProductAnalyticsRuntime> | null = null;

/**
 * Called from index.tsx. Dormant unless both a flag AND a public project
 * token are supplied. The direct transport itself requires fresh consent.
 * Does not import or initialize posthog-js.
 */
export function prepareProductAnalyticsRuntime(): void {
  if (runtime || import.meta.env.VITE_POSTHOG_ENABLED !== 'true') return;

  const projectToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
  if (typeof projectToken !== 'string') return;

  runtime = createProductAnalyticsRuntime({ enabled: true, projectToken });
}

export function captureProductAnalyticsEvent(event: ProductAnalyticsEvent): boolean {
  return runtime?.capture(event) ?? false;
}

export function shutdownProductAnalyticsRuntime(): void {
  runtime?.dispose();
  runtime = null;
}
