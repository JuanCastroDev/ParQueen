import { readFileSync,realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { plan,sessionDigest } from './parqueen-handoff-runner.mjs';

async function check() {
  const s=JSON.parse(process.env.PARQUEEN_STAGE_A_SESSION || 'null');
  if(!s || !/^[0-9a-f]{64}$/.test(s.nonce) || !Number.isInteger(s.port) ||
     s.port<1 || s.port>65535 || !Number.isSafeInteger(s.expires) || Date.now()>=s.expires) throw Error();
  const p=plan(s.input);
  if(!process.env.PROJECT_DIR || !process.env.RESOURCE_DIR ||
     process.env.GCLOUD_PROJECT!==p.project ||
     realpathSync(process.env.PROJECT_DIR)!==realpathSync(p.root) ||
     realpathSync(process.env.RESOURCE_DIR)!==realpathSync(join(p.root,'functions'))) throw Error();
  const bytes=readFileSync(s.configPath);
  const sha=createHash('sha256').update(bytes).digest('hex');
  const binding={project:p.project,stage:p.stage,only:p.only,manifestHash:p.manifestHash,
    archiveSha256:p.archiveSha256,source:join(p.root,'functions'),configSha256:sha};
  if(sessionDigest(binding)!==sessionDigest(s.binding)) throw Error();
  const response=await fetch('http://127.0.0.1:'+s.port+'/consume',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),
    headers:{authorization:'Bearer '+s.nonce,'x-parqueen-binding':sessionDigest(binding)},
  });
  if(response.status!==204) throw Error();
}
check().catch(()=>{console.error('Stage A predeploy refused');process.exitCode=1;});
