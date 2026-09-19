'use strict';

function requireEmulatorProjectId(env = process.env) {
    const projectId = env.GCLOUD_PROJECT;
    if (typeof projectId !== 'string' || projectId.trim() === '') {
        throw new Error('GCLOUD_PROJECT must explicitly identify the Firebase emulator test project');
    }
    return projectId.trim();
}

module.exports = { requireEmulatorProjectId };
