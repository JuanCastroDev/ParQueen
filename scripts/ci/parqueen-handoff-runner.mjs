import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../release-preflight/waitlist-deploy-guard.mjs';

const manifestFile = fileURLToPath(new URL('./parqueen-handoff-release.json', import.meta.url));
const guardFile = fileURLToPath(new URL('../release-preflight/waitlist-deploy-guard.mjs', import.meta.url));
const manifestHash = '4f7d50b30249155111f160aa4759afe8fdb6d3bb7c678bd8dbde91c926854115';
const digest = b => createHash('sha256').update(b).digest('hex');
function pinned(file, expected, label) {
  const bytes=readFileSync(file);
  if(digest(bytes)!==expected) throw Error(label+' digest mismatch');
  return bytes;
}
export function verifyManifest(manifest = manifestFile) {
  const canonical=readFileSync(manifest,'utf8').replaceAll('\r\n','\n');
  if(digest(canonical)!==manifestHash) throw Error('Manifest digest mismatch');
  const binding=JSON.parse(canonical);
  const guard=readFileSync(guardFile);
  const guardHash=digest(guard);
  // Accept the two reviewed checkout representations of the same guard blob.
  if(![binding.waitlistGuardSha256,'c4fbd51626672eb3c8bffdfac5b8244a0cb590a42b7c4de6548891e7e4d58b46'].includes(guardHash)) {
    throw Error('Guard digest mismatch');
  }
  return binding;
}
export function plan({ stage, project, root, archive, inventory, manifest = manifestFile, ...extra }) {
  if(Object.keys(extra).length) throw Error('Unexpected runner argument');
  const binding=verifyManifest(manifest);
  if(project!==binding.project || !Object.hasOwn(binding.stages,stage)) throw Error('Invalid target or stage');
  const only=binding.stages[stage].map(name=>'functions:'+name).join(',');
  pinned(archive,binding.archiveSha256,'Archive');
  const rows=JSON.parse(pinned(inventory,binding.inventorySha256,'Inventory'));
  if(rows.length!==binding.sourceFiles) throw Error('Source count mismatch');
  const source=join(realpathSync(root),'functions');
  if(lstatSync(source).isSymbolicLink()) throw Error('Source redirect');
  const entries=new Map(rows.map(row=>[row.path.replaceAll('\\','/'),row.sha256.toLowerCase()]));
  const walk=(dir,prefix='')=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      if(!prefix && entry.name==='node_modules' && entry.isDirectory()) continue;
      const rel=prefix+entry.name;
      const file=join(dir,entry.name);
      if(entry.isSymbolicLink()) throw Error('Source redirect');
      if(entry.isDirectory()) walk(file,rel+'/');
      else if(!entry.isFile()||!entries.has(rel)) throw Error('Unexpected source entry');
      else { pinned(file,entries.get(rel),'Source'); entries.delete(rel); }
    }
  };
  walk(source);
  if(entries.size) throw Error('Missing source files');
  const guarded=decide({project,only,source:root});
  if(!guarded.ok) throw Error(guarded.message);
  return Object.freeze({stage,project,only,archiveSha256:binding.archiveSha256,manifestHash,
    root:resolve(root), args:Object.freeze(['deploy','--project',project,'--config','firebase.stage-a.json','--only',only])});
}

// Rehearsal has no production execution path and emits no deployable config.
// The stub must check that the captured CLI selection is the guarded selection.
export function rehearse(input, stub) {
  const receipt=plan(input);
  return stub(receipt.args,receipt);
}

const hook=fileURLToPath(new URL('./parqueen-handoff-predeploy.mjs',import.meta.url));
export const sessionDigest = value => digest(JSON.stringify(value));
const safeQuote=value=>{
  if(!/^[A-Za-z0-9_ .:\\/()-]+$/.test(value)) throw Error('Unsafe hook path');
  return '"'+value+'"';
};

export async function runControlled(input,launch,{lifetimeMs=120000}={}) {
  const receipt=plan(input);
  const nonce=randomBytes(32).toString('hex');
  const configPath=join(receipt.root,'.parqueen-stage-a-'+nonce.slice(0,16)+'.json');
  const config=JSON.stringify({functions:{source:'functions',runtime:'nodejs22',
    predeploy:[safeQuote(process.execPath)+' '+safeQuote(hook)]}});
  const binding=Object.freeze({project:receipt.project,stage:receipt.stage,only:receipt.only,
    manifestHash:receipt.manifestHash,archiveSha256:receipt.archiveSha256,
    source:join(receipt.root,'functions'),configSha256:digest(config)});
  const expires=Date.now()+lifetimeMs;
  let consumed=false;
  const server=createServer((req,res)=>{
    if(req.method==='POST' && req.url==='/consume' && req.headers.authorization==='Bearer '+nonce &&
       req.headers['x-parqueen-binding']===sessionDigest(binding) && !consumed && Date.now()<expires) {
      consumed=true;
      res.writeHead(204).end();
    } else res.writeHead(403).end();
  });
  let written=false;
  try {
    await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
    writeFileSync(configPath,config,{flag:'wx'});
    written=true;
    const args=Object.freeze(['deploy','--project',receipt.project,'--config',configPath,'--only',receipt.only,'--non-interactive']);
    const env={...process.env,PARQUEEN_STAGE_A_SESSION:JSON.stringify({
      nonce,port:server.address().port,expires,binding,configPath,
      input:{...input,root:receipt.root},
    })};
    const result=await launch(args,{cwd:receipt.root,env});
    if(result!==0 || !consumed) throw Error('Firebase command failed or predeploy authorization was not consumed');
    return binding;
  } finally {
    server.closeAllConnections();
    if(server.listening) await new Promise(ok=>server.close(ok));
    if(written) unlinkSync(configPath);
  }
}

// External founder authorization must precede calling this entry point.
// No shell, custom CLI path, extra flags, or force option is accepted.
export async function executeStage(input,approval) {
  const {stage,project,only}=plan(input);
  if(approval!==`FOUNDER GO ${project} ${stage} ${only}`) throw Error('Exact stage authorization required');
  const toolsRoot=join(process.env.LOCALAPPDATA,'Author Software/nvm/installs/v22.23.3/node_modules/firebase-tools');
  if(JSON.parse(readFileSync(join(toolsRoot,'package.json'),'utf8')).version!=='15.31.0') throw Error('Unsupported Firebase CLI version');
  const cli=join(toolsRoot,'lib/bin/firebase.js');
  return runControlled(input,(args,options)=>new Promise((ok,fail)=>{
    const child=spawn(process.execPath,[cli,...args],{...options,stdio:'inherit',shell:false});
    const abort=()=>child.kill();
    process.once('SIGINT',abort);
    process.once('SIGTERM',abort);
    child.once('error',fail);
    child.once('close',code=>{
      process.removeListener('SIGINT',abort);
      process.removeListener('SIGTERM',abort);
      ok(code);
    });
  }));
}
