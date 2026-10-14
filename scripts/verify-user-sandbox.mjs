// Ordinary-user acceptance, with synthetic state only. Run as root on the server.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';
import { Sandbox } from '../src/sandbox.mjs';
const base='http://127.0.0.1:32215/assistant';
const login=JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/login.json'));
async function api(path,token,method='GET',data) {
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const value=await r.json();assert.ok(r.ok,JSON.stringify({status:r.status,error:value.error}));return value;
}
const store=new Store('/home/admin/.local/share/pi-agent-multi-tenant/data');
const sb=new SilverBullet(store,JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/silverbullet.json')));
const sandbox=new Sandbox('/run/pi-sandbox/runner.sock');
const admin=await api('/api/login',null,'POST',login);
let user;
try {
  const username='verify_sandbox_'+Date.now(),password=randomBytes(24).toString('base64url');
  user=await api('/api/admin/users',admin.token,'POST',{username,password});
  assert.equal(user.role,'user');
  const auth=await api('/api/login',null,'POST',{username,password});
  const conversation=await api('/api/conversations',auth.token,'POST',{title:'合成普通用户沙箱验收'});
  const run=await api('/api/conversations/'+conversation.id+'/runs',auth.token,'POST',{
    prompt:'这是虚构验收。请用cmd执行 TZ=Asia/Shanghai date 查询现在北京时间，修改你自己的agent.md为“FAKE_USER_STYLE：默认中文简短回复”，实际保存；然后在自己的沙箱中运行 python3 -c "print(12345)" 并回复输出。'});
  let result;
  for(let i=0;i<130;i++) {
    result=await api('/api/runs/'+run.id,auth.token);
    if(!['queued','running'].includes(result.status))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(result.status,'completed');
  const events=(await api('/api/runs/'+run.id+'/trace',auth.token)).events;
  for(const name of ['persona_read','persona_write','cmd']) {
    assert.ok(events.some(e=>e.kind==='sdk_event' && e.payload.type==='tool_execution_start' && e.payload.toolName===name),'Missing '+name);
  }
  assert.ok(events.some(e=>e.kind==='context' && !e.payload.activeTools.includes('time_now')));
  assert.ok(events.some(e=>e.kind==='sdk_event' && e.payload.type==='tool_execution_start' && e.payload.toolName==='cmd' &&
    /\bdate\b/.test(e.payload.args.command)), 'Missing real time command');
  assert.match(store.agentProfile(user.id),/FAKE_USER_STYLE/);
  assert.match(result.response,/12345/);
  console.log(JSON.stringify({ordinary_user_time_via_cmd:true,dedicated_time_tool_removed:true,ordinary_user_agent_md_saved:true,ordinary_user_sandbox_cmd:true,tool_trace_verified:true}));
} finally {
  if(user) {
    const row=store.userById(user.id);
    assert.ok(row.username.startsWith('verify_sandbox_') && row.id===user.id && !store.wechatBinding(user.id));
    assert.ok(!store.db.prepare("SELECT id FROM runs WHERE user_id=? AND status IN ('queued','running')").get(user.id));
    await sandbox.call('/release',{userId:user.id});
    const state=store.integration(user.id,'silverbullet')?.state;
    if(state) {
      const accounts=await sb.admin('users');
      for(const [name,role] of [[state.humanUsername,'human'],[state.agentUsername,'agent']])assert.equal(accounts[name]?.fullName,`Pi tenant ${user.id} ${role}`);
      if(state.spaceId)await sb.admin('spaces/'+state.spaceId,'DELETE');
      for(const name of [state.humanUsername,state.agentUsername])await sb.admin('users/'+name,'DELETE');
    }
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const runs=store.db.prepare('SELECT id FROM runs WHERE user_id=?').all(user.id);
      for(const run of runs)for(const table of ['traces','run_modes'])store.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
      store.db.prepare('DELETE FROM runs WHERE user_id=?').run(user.id);
      for(const c of store.conversations(user.id))store.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(c.id);
      store.db.prepare('DELETE FROM conversations WHERE user_id=?').run(user.id);
      for(const table of ['auth_sessions','memories','agent_profiles','reminders','integrations','wechat_logins'])store.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
      store.db.prepare('DELETE FROM users WHERE id=?').run(user.id);store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
    assert.match(user.id,/^[0-9a-f-]{36}$/);rmSync(store.directory+'/tenants/'+user.id,{recursive:true,force:true});
  }
  await api('/api/logout',admin.token,'POST',{});await sb.close();store.close();
}
