'use strict';

// Vitest loads setup files before importing a test module. This file must
// stay free of Firebase imports so a rejected environment never starts an SDK.
require('./isolatedNetworkGuard').install();
require('./isolatedEmulatorGuard').assertIsolatedEmulator();
