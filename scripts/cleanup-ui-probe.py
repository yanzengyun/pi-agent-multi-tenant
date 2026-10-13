"""Remove only the synthetic account recorded by verify-ui.mjs."""
import json
import subprocess
from pathlib import Path

fixture = Path('/tmp/pi-admin-check-user.json')
user = json.loads(fixture.read_text())
code = 'const fixture=' + json.dumps(user) + ';\n' + r'''
import {readFileSync,rmSync} from 'node:fs';
import {Store} from '/home/admin/pi-agent-multi-tenant-live/src/store.mjs';
import {SilverBullet} from '/home/admin/pi-agent-multi-tenant-live/src/silverbullet.mjs';
const store=new Store('/home/admin/.local/share/pi-agent-multi-tenant/data');
const user=store.userById(fixture.id);
if(!user || user.username!==fixture.username || !user.username.startsWith('verify_ui_') || store.wechatBinding(user.id) || store.conversations(user.id).some(c=>c.title!=='人物设定草稿'))throw new Error('Refusing fixture cleanup');
const sb=new SilverBullet(store,JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/silverbullet.json')));
const state=store.integration(user.id,'silverbullet')?.state;
if(state){
 const accounts=await sb.admin('users');
 for(const [name,role] of [[state.humanUsername,'human'],[state.agentUsername,'agent']])if(accounts[name] && accounts[name].fullName!==`Pi tenant ${user.id} ${role}`)throw new Error('Ownership mismatch');
 if(state.spaceId)await sb.admin('spaces/'+state.spaceId,'DELETE');
 for(const name of [state.humanUsername,state.agentUsername])if(accounts[name])await sb.admin('users/'+name,'DELETE');
}
store.db.exec('BEGIN IMMEDIATE');
try{
 for(const c of store.conversations(user.id)){
  const runs=store.db.prepare('SELECT id FROM runs WHERE conversation_id=?').all(c.id);
  for(const run of runs){if(store.runMode(run.id)!=='persona_draft')throw new Error('Unexpected fixture run');for(const table of ['traces','run_modes'])store.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);}
  store.db.prepare('DELETE FROM runs WHERE conversation_id=?').run(c.id);
  store.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(c.id);
  store.db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(c.id,user.id);
 }
 store.db.prepare('DELETE FROM memories WHERE user_id=?').run(user.id);
 for(const table of ['reminders','integrations','wechat_logins','auth_sessions'])store.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
 store.db.prepare('DELETE FROM agent_profiles WHERE user_id=?').run(user.id);
 store.db.prepare('DELETE FROM invitations WHERE target_user=?').run(user.id);
 if(fixture._inviteId)store.db.prepare('DELETE FROM invitations WHERE id=? AND target_user IS NULL').run(fixture._inviteId);
 store.db.prepare('DELETE FROM users WHERE id=?').run(user.id);store.db.exec('COMMIT');
}catch(e){store.db.exec('ROLLBACK');throw e;}
if(!/^[0-9a-f-]{36}$/.test(user.id))throw new Error('Unexpected fixture ID');
rmSync(store.directory+'/tenants/'+user.id,{recursive:true,force:true});
await sb.close();store.close();console.log('synthetic_browser_user_removed');
'''
workspace = Path(__file__).resolve().parents[2]
subprocess.run(['ssh','-i',str(workspace/'alibaba_host/config/pic.pem'),'-o','IdentitiesOnly=yes',
 '-o','UserKnownHostsFile=/tmp/stockclaw-known-hosts','-o','BatchMode=yes','-o','ConnectTimeout=10',
 'root@123.56.157.198','runuser -u admin -- /usr/local/bin/node --input-type=module -'],input=code,text=True,check=True)
fixture.unlink()
