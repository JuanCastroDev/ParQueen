'use strict';

const { requireEmulatorProjectId } = require('./emulatorProjectId');

describe('requireEmulatorProjectId', () => {
    it('uses the explicitly supplied demo project even when other project variables name production', () => {
        expect(requireEmulatorProjectId({
            GCLOUD_PROJECT: 'demo-parqueen-phase2a15',
            GOOGLE_CLOUD_PROJECT: 'parkqueen-46475363-ccf36',
            FIREBASE_CONFIG: JSON.stringify({ projectId: 'parkqueen-46475363-ccf36' }),
        })).toBe('demo-parqueen-phase2a15');
    });

    it.each([
        {},
        { GCLOUD_PROJECT: '' },
        { GCLOUD_PROJECT: '   ' },
        { FIREBASE_CONFIG: JSON.stringify({ projectId: 'parkqueen-46475363-ccf36' }) },
    ])('fails closed without an explicit GCLOUD_PROJECT', env => {
        expect(() => requireEmulatorProjectId(env)).toThrow(
            'GCLOUD_PROJECT must explicitly identify the Firebase emulator test project',
        );
    });
});
