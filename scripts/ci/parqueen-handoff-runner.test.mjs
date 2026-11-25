import { describe,it,expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { decide } from '../release-preflight/waitlist-deploy-guard.mjs';
import { plan,rehearse,runControlled } from './parqueen-handoff-runner.mjs';

const optedIn=process.env.PARQUEEN_PRIVATE_REHEARSAL_ROOT;
const root=optedIn ?? process.cwd();
const project='parkqueen-46475363-ccf36';
const fixture=()=>({stage:'cleanup',project,root,
  inventory:join(root,'t789-review-source-manifest.json'),
  archive:join(root,'t789-PRIVATE-REVIEW-NOT-FOR-DEPLOYMENT.zip')});
describe.skipIf(!optedIn)('explicitly opted-in private candidate rehearsal',()=>{
  for(const [stage,only] of [
    ['cleanup','functions:cleanupAbandonedArrivedHandoffs'],
    ['feedback','functions:awardCrowns,functions:updateTrustOnFeedback'],
    ['callable','functions:completeHandoffSuccess'],
  ]) it('binds '+stage+' to the allowlisted Firebase argv',()=>{
    expect(rehearse({...fixture(),stage},(args,r)=>{
      expect(args).toEqual(['deploy','--project',project,'--config','firebase.stage-a.json','--only',only]);
      expect(r.only).toBe(only);
      expect(Object.isFrozen(args)).toBe(true);
      return 'captured';
    })).toBe('captured');
  });
  for(const [label,edit,error] of [
    ['missing stage',{stage:undefined},'Invalid target'],
    ['generic stage',{stage:'functions'},'Invalid target'],
    ['prefix stage',{stage:'award'},'Invalid target'],
    ['wildcard stage',{stage:'*'},'Invalid target'],
    ['waitlist stage',{stage:'joinWaitlist'},'Invalid target'],
    ['added selector',{only:'functions:joinWaitlist'},'Unexpected runner argument'],
    ['missing project',{project:undefined},'Invalid target'],
    ['wrong project',{project:'demo-other'},'Invalid target'],
    ['modified manifest',{manifest:join(root,'t789-review-source-manifest.json')},'Manifest digest mismatch'],
    ['modified archive',{archive:join(root,'t789-review-source-manifest.json')},'Archive digest mismatch'],
    ['modified inventory',{inventory:join(root,'t789-PRIVATE-REVIEW-NOT-FOR-DEPLOYMENT.zip')},'Inventory digest mismatch'],
  ]) it('rejects '+label,()=>expect(()=>plan({...fixture(),...edit})).toThrow(error));
  it('rejects a modified source digest',()=>{
    const scratch=mkdtempSync(join(tmpdir(),'parqueen-t792-negative-'));
    mkdirSync(join(scratch,'functions'));
    writeFileSync(join(scratch,'functions','mutualSuccessJoin.js'),'// negative fixture\n');
    expect(()=>plan({...fixture(),root:scratch})).toThrow('Source digest mismatch');
  });
  it('original guard denies generic and waitlist selection for the archive',()=>{
    for(const only of [undefined,'functions','functions:joinWaitlist'])
      expect(decide({project,source:root,only}).ok).toBe(false);
  });

  function hook(args,options,mutate=()=>{},second=false){
    const cfg=JSON.parse(readFileSync(args[4],'utf8'));
    expect(Object.keys(cfg)).toEqual(['functions']);
    expect(cfg.functions.source).toBe('functions');
    expect(cfg.functions.runtime).toBe('nodejs22');
    const [command]=cfg.functions.predeploy;
    const match=/^"([^"]+)" "([^"]+)"$/.exec(command);
    expect(match).not.toBeNull();
    const env={...options.env,GCLOUD_PROJECT:args[2],PROJECT_DIR:options.cwd,RESOURCE_DIR:join(options.cwd,'functions')};
    mutate(env,args[4]);
    const call=()=>new Promise((ok,fail)=>{
      const child=spawn(match[1],[match[2]],{...options,env,stdio:'ignore',shell:false});
      child.once('error',fail);
      child.once('close',ok);
    });
    return second ? (async()=>{expect(await call()).toBe(0);return call();})() : call();
  }
  const change=update=>env=>{
    const session=JSON.parse(env.PARQUEEN_STAGE_A_SESSION);
    update(session);
    env.PARQUEEN_STAGE_A_SESSION=JSON.stringify(session);
  };
  for(const stage of ['cleanup','feedback','callable']) it('consumes generated hook for '+stage,async()=>{
    let config;
    const binding=await runControlled({...fixture(),stage},async(args,opts)=>{
      config=args[4];
      expect(args[6]).toBe(plan({...fixture(),stage}).only);
      expect(args.at(-1)).toBe('--non-interactive');
      return hook(args,opts);
    });
    expect(binding.stage).toBe(stage);
    expect(existsSync(config)).toBe(false);
  });
  for(const [name,mutate] of [
    ['missing session',env=>delete env.PARQUEEN_STAGE_A_SESSION],
    ['corrupted session',env=>env.PARQUEEN_STAGE_A_SESSION='!'],
    ['wrong project',env=>env.GCLOUD_PROJECT='demo-other'],
    ['wrong resource',env=>env.RESOURCE_DIR=env.PROJECT_DIR],
    ['wrong stage',change(s=>s.input.stage='feedback')],
    ['expired',change(s=>s.expires=0)],
    ['extra selector',change(s=>s.binding.only+=',functions:joinWaitlist')],
    ['generic selector',change(s=>s.binding.only='functions')],
    ['modified config',(_env,file)=>writeFileSync(file,'{}')],
  ]) it('hook refuses '+name,async()=>{
    await expect(runControlled(fixture(),(args,opts)=>hook(args,opts,mutate))).rejects.toThrow('predeploy authorization');
  });
  it('rejects replay of a consumed invocation',async()=>{
    await expect(runControlled(fixture(),(args,opts)=>hook(args,opts,undefined,true))).rejects.toThrow('predeploy authorization');
  });
  it('rejects a child that exits without invoking the hook',async()=>{
    await expect(runControlled(fixture(),async()=>0)).rejects.toThrow('predeploy authorization');
  });
  it('rejects a changed source fixture after the runner verified it',async()=>{
    await expect(runControlled(fixture(),(args,opts)=>hook(args,opts,change(s=>{
      const scratch=mkdtempSync(join(tmpdir(),'parqueen-t793-negative-'));
      mkdirSync(join(scratch,'functions'));
      writeFileSync(join(scratch,'functions','mutualSuccessJoin.js'),'changed');
      s.input.root=scratch;
    })))).rejects.toThrow('predeploy authorization');
  });
});
