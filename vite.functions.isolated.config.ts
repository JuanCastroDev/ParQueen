import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'functions/deletionFenceReconciliation.integration.test.js',
      'functions/parkingCallableDeletionFence.emulator.integration.test.js',
      'functions/parkingCallablePostReadRace.emulator.integration.test.js',
      'functions/s7MixedVersion.legacyClaims.emulator.integration.test.js',
      'functions/s7MixedVersion.candidateDeletion.emulator.integration.test.js',
      'functions/s7MixedVersion.deployedBaseline.emulator.integration.test.js',
      'functions/s7T2LegacyRecovery.emulator.integration.test.js',
      'functions/s7T2OrphanRecoveryRace.emulator.integration.test.js',
      // S7 t684u: lock-writer invariant F1 behavior tests.
      'functions/s7T2LockWriterF1.emulator.integration.test.js',
      // S4 t695u/t699u: deleted-user claim release race and fence regressions.
      'functions/deletedUserClaimRelease.emulator.integration.test.js',
      'functions/deletedUserClaimRelease.identity.emulator.integration.test.js',
      'functions/deleteAccountClaimReleaseRace.emulator.integration.test.js',
      // S4 t699u: approved malformed-expiry policy N.
      'functions/deletedUserClaimRelease.expiryRepair.emulator.integration.test.js',
      // H1: real HTTP account-deletion flow is selected separately by name.
      'functions/deleteAccount.integration.test.js',
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 1,
    retry: 0,
  },
});
