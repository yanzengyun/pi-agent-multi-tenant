// Real SB integration in a disposable container; only synthetic users and notes.
import {execFile,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {SilverBullet} from '../src/silverbullet.mjs';
import {MockEngine} from '../src/engine.mjs';
import {PiEngine} from '../src/pi-engine.mjs';
import {makeServer} from '../src/server.mjs';
const exec=promisify(execFile),id=randomBytes(4).toString('hex'),name='pi-sb-test-'+id,volume=name+'-data';
const directory=mkdtempSync(join(tmpdir(),'pi-sb-live-'));let app,store,sbProcess,sbExited,spawnError,usedDocker=false;
const report={version:'2.12.0',synthetic_users:2};
try{
 let port;
 if(process.env.ASSISTANT_SB_BINARY){
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));port=reservation.address().port;
  await new Promise(r=>reservation.close(r));const data=join(directory,'sb');mkdirSync(data);
  sbProcess=spawn(process.env.ASSISTANT_SB_BINARY,['-L','127.0.0.1','-p',String(port),data],{stdio:'ignore',env:{...process.env,SB_RUNTIME_API:'0'}});
  sbProcess.on('error',error=>{spawnError=error;});sbExited=new Promise(r=>sbProcess.once('close',r));report.transport='official_server_binary';
 }else{
  usedDocker=true;await exec('docker',['volume','create',volume]);
  await exec('docker',['run','-d','--name',name,'--memory','256m','--cpus','1','-e','PUID=10001','-e','PGID=10001',
   '-e','SB_RUNTIME_API=0','-p','127.0.0.1::3000','-v',volume+':/data',process.env.ASSISTANT_SB_IMAGE||'ghcr.io/silverbulletmd/silverbullet:2.12.0-slim']);
  port=(await exec('docker',['port',name,'3000/tcp'])).stdout.trim().split(':').at(-1);report.transport='official_container';
 }
 const sbUrl='http://127.0.0.1:'+port;
 let ready=false;
 for(let attempt=0;attempt<60;attempt++){if(spawnError)throw new Error('SB binary could not start',{cause:spawnError});try{const r=await fetch(sbUrl+'/.instance',{signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 assert.ok(ready,'SB container not ready');
 const password=randomBytes(24).toString('hex');
 const bootstrap=await fetch(sbUrl+'/.setup/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({primaryUrl:sbUrl,adminUsername:'testadmin',adminPassword:password,space:{name:'测试','prefix':'/bootstrap',folder:'spaces/bootstrap',revisions:'disabled'}})});
 const setupText=await bootstrap.text();
 if(bootstrap.status!==200)console.log(setupText.replaceAll(password,'[REDACTED]').slice(0,600));
 assert.equal(bootstrap.status,200);assert.equal(JSON.parse(setupText).status,'ok');
 store=new Store(directory);const sb=new SilverBullet(store,{baseUrl:sbUrl,username:'testadmin',password});
 let engine=new MockEngine();
 if(process.env.ASSISTANT_LIVE_KEY_FILE){
  const key=JSON.parse(readFileSync(process.env.ASSISTANT_LIVE_KEY_FILE,'utf8')).key;
  assert.ok(key);
  engine=new PiEngine({sdkModule:process.env.PI_SDK_MODULE||'@earendil-works/pi-coding-agent',modelsPath:resolve('models.json'),provider:'minimax-cn',model:'MiniMax-M3.1-Flash-Preview',thinkingLevel:'medium',apiKey:key});
  await engine.initialize();
 }
 app=await makeServer({store,engine,adminPassword:password,silverbullet:sb});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function api(path,token,method='GET',data){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});return{status:r.status,data:await r.json()};}
 const admin=(await api('/api/login',null,'POST',{username:'admin',password})).data.token,users=[];
 for(const username of ['alice','bob']){
  const created=await api('/api/admin/users',admin,'POST',{username,password});assert.equal(created.status,201);
  const token=(await api('/api/login',null,'POST',{username,password})).data.token;
  users.push({...created.data,token});
  const result=await api('/api/admin/users/'+created.data.id+'/silverbullet',admin,'POST',{});
  if(result.status!==201){console.log(JSON.stringify({provision_status:result.status,stage:store.integration(created.data.id,'silverbullet')?.status}));}
  assert.equal(result.status,201);assert.equal(result.data.status,'ready');
  assert.equal((await api('/api/admin/users/'+created.data.id+'/silverbullet/credentials',token,'POST',{})).status,403);
 }
 report.private_spaces_created=true;console.log(JSON.stringify({private_spaces_created:true}));
 const page='独立测试/'+id,route='/api/notes/'+encodeURIComponent(page);
 assert.equal((await api(route,users[0].token,'PUT',{content:'FAKE_ALICE_PRIVATE'})).status,200);
 const note=await api(route,users[0].token);assert.equal(note.data.content,'FAKE_ALICE_PRIVATE');
 assert.equal((await api(route,users[1].token)).status,404);
 assert.equal((await api(route,users[0].token,'PUT',{content:'overwrite'})).status,409);
 assert.equal((await api(route,users[0].token,'PUT',{content:'updated',etag:note.data.etag})).status,200);
 assert.equal((await api(route,users[0].token,'PUT',{content:'stale',etag:note.data.etag})).status,409);
 const a=store.integration(users[0].id,'silverbullet').state,b=store.integration(users[1].id,'silverbullet').state;
 const cross=await fetch(sbUrl+b.prefix+'/.fs/index.md',{headers:{Authorization:'Bearer '+a.token,'X-Sync-Mode':'true'}});
 assert.ok([401,403,404].includes(cross.status));report.real_agent_cross_space_denied=true;report.etag_conflicts_enforced=true;
 const anon=await fetch(sbUrl+a.prefix+'/.fs/index.md',{redirect:'manual',headers:{'X-Sync-Mode':'true'}});assert.ok([401,403,404].includes(anon.status));report.anonymous_access_denied=true;
 const before=a.token;assert.equal((await api('/api/admin/users/'+users[0].id+'/silverbullet',admin,'POST',{})).status,201);
 assert.equal(store.integration(users[0].id,'silverbullet').state.token,before);report.idempotent_provisioning=true;
 if(engine.mode==='pi'){
  const c=(await api('/api/conversations',users[0].token,'POST',{title:'虚构真实工具测试'})).data;
  const modelPage='模型测试/'+id;
  const run=(await api('/api/conversations/'+c.id+'/runs',users[0].token,'POST',{prompt:'必须调用 note_write 创建笔记 '+modelPage+'，内容是 FAKE_MODEL_NOTE_OK，成功后只回复完成。'})).data;
  let result;
  for(let attempt=0;attempt<130;attempt++){result=(await api('/api/runs/'+run.id,users[0].token)).data;if(!['queued','running'].includes(result.status))break;await new Promise(r=>setTimeout(r,1000));}
  if(result.status!=='completed')console.log(JSON.stringify({run_status:result.status,error:result.error,diagnostics:store.traces(users[0].id,run.id).filter(t=>t.kind==='failed')}));
  assert.equal(result.status,'completed');
  const written=await api('/api/notes/'+encodeURIComponent(modelPage),users[0].token);assert.equal(written.status,200);assert.match(written.data.content,/FAKE_MODEL_NOTE_OK/);
  assert.equal((await api('/api/notes/'+encodeURIComponent(modelPage),users[1].token)).status,404);
  const trace=(await api('/api/runs/'+run.id+'/trace',users[0].token)).data;
  assert.ok(trace.events.some(e=>e.kind==='sdk_event'&&e.payload.type==='tool_execution_start'&&e.payload.toolName==='note_write'));
  assert.equal((await api('/api/runs/'+run.id+'/trace',users[1].token)).status,404);report.real_pi_sdk_note_tool=true;
  const readRun=(await api('/api/conversations/'+c.id+'/runs',users[0].token,'POST',{prompt:'必须调用 note_read 读取 '+modelPage+'，然后只回复笔记正文。'})).data;
  let readResult;
  for(let attempt=0;attempt<130;attempt++){readResult=(await api('/api/runs/'+readRun.id,users[0].token)).data;if(!['queued','running'].includes(readResult.status))break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(readResult.status,'completed');assert.match(readResult.response,/FAKE_MODEL_NOTE_OK/);
  const readTrace=(await api('/api/runs/'+readRun.id+'/trace',users[0].token)).data;
  assert.ok(readTrace.events.some(e=>e.kind==='sdk_event'&&e.payload.type==='tool_execution_start'&&e.payload.toolName==='note_read'));
  report.real_pi_sdk_note_read=true;
 }
 const usersConfig=await sb.admin('users');report.all_tenant_accounts_non_admin=[a.humanUsername,a.agentUsername,b.humanUsername,b.agentUsername].every(n=>usersConfig[n].admin===false);assert.ok(report.all_tenant_accounts_non_admin);
 writeFileSync('test/sb-live-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 if(app)await app.close();else store?.close();
 if(sbProcess){sbProcess.kill('SIGTERM');await sbExited;}
 if(usedDocker){await exec('docker',['rm','-f',name]).catch(()=>{});await exec('docker',['volume','rm',volume]).catch(()=>{});}
 rmSync(directory,{recursive:true,force:true});
}
