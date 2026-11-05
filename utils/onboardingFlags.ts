// Onboarding 2.0 release switch (Blueprint D11).
// Build-time and OFF by default: production builds keep the legacy onboarding until the flag is set on purpose
// (VITE_ONBOARDING_V2=1). Turning it off again is the rollback path; no data migration is needed either way.
export const ONBOARDING_V2_ENABLED: boolean = import.meta.env.VITE_ONBOARDING_V2 === '1';
