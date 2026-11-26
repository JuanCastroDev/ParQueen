// Onboarding 2.0 release switch (Blueprint D11).
// Build-time. OFF in tests and the dev server; ON in production builds via the committed .env.production
// (VITE_ONBOARDING_V2=1). Rollback: build with VITE_ONBOARDING_V2=0 in the shell, or revert that line.
// No data migration is needed either way.
export const ONBOARDING_V2_ENABLED: boolean = import.meta.env.VITE_ONBOARDING_V2 === '1';
