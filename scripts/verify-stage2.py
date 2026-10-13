"""Run on the server: exercise real dev SB and the public QR endpoint only.
Never confirms an existing production WeChat account or sends a WeChat message.
"""
import json,secrets,time,urllib.request,urllib.error,sqlite3,hashlib,subprocess
from pathlib import Path
base='http://127.0.0.1:32214'
def api(path,token=None,method='GET',data=None):
 headers={'Content-Type':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 request=urllib.request.Request(base+path,method=method,headers=headers,data=json.dumps(data).encode() if data is not None else None)
 try:
  with urllib.request.urlopen(request,timeout=40) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
login=json.loads(Path('/home/admin/.config/pi-agent-multi-tenant-dev/login.json').read_text())
status,auth=api('/api/login',method='POST',data=login);assert status==200
admin=auth['token'];users=[]
for label in ['alice','bob']:
 username='sb_test_'+label+'_'+secrets.token_hex(3);password=secrets.token_urlsafe(24)
 status,user=api('/api/admin/users',admin,'POST',{'username':username,'password':password});assert status==201
 status,auth=api('/api/login',method='POST',data={'username':username,'password':password});assert status==200
 user['token']=auth['token'];users.append(user)
 status,sb=api('/api/admin/users/'+user['id']+'/silverbullet',admin,'POST',{});assert status==201, sb
 assert sb['status']=='ready' and 'token' not in sb and 'password' not in sb
 assert api('/api/admin/users/'+user['id']+'/silverbullet/credentials',user['token'],'POST',{})[0]==403
 print(json.dumps({'provisioned_user':label,'private_space_ready':True}),flush=True)

page='隔离测试/'+secrets.token_hex(4)
encoded=urllib.parse.quote(page,safe='')
assert api('/api/notes/'+encoded,users[0]['token'],'PUT',{'content':'FAKE_ALICE_PRIVATE_NOTE'})[0]==200
status,read=api('/api/notes/'+encoded,users[0]['token']);assert status==200 and read['content']=='FAKE_ALICE_PRIVATE_NOTE'
assert api('/api/notes/'+encoded,users[1]['token'])[0]==404
assert api('/api/notes/'+encoded,users[0]['token'],'PUT',{'content':'bad overwrite'})[0]==409
assert api('/api/notes/'+encoded,users[0]['token'],'PUT',{'content':'FAKE_ALICE_UPDATED','etag':read['etag']})[0]==200
assert api('/api/notes/'+encoded,users[0]['token'],'PUT',{'content':'stale','etag':read['etag']})[0]==409

# Test SB's real authorization directly, rather than relying only on our API filter.
db=sqlite3.connect('file:/home/admin/.local/share/pi-agent-multi-tenant-dev/data/assistant.sqlite?mode=ro',uri=True)
states=[json.loads(db.execute('SELECT state FROM integrations WHERE user_id=? AND kind=?',(user['id'],'silverbullet')).fetchone()[0]) for user in users]
sbbase=json.loads(Path('/home/admin/.config/pi-agent-multi-tenant-dev/silverbullet.json').read_text())['baseUrl']
request=urllib.request.Request(sbbase+states[1]['prefix']+'/.fs/index.md',headers={'Authorization':'Bearer '+states[0]['token'],'X-Sync-Mode':'true'})
try:
 urllib.request.urlopen(request,timeout=10);raise AssertionError('Cross-space access allowed')
except urllib.error.HTTPError as e:assert e.code in (401,403,404)
assert api('/api/admin/users/'+users[0]['id']+'/silverbullet',admin,'POST',{})[0]==201
assert states[0]['token']==json.loads(db.execute('SELECT state FROM integrations WHERE user_id=? AND kind=?',(users[0]['id'],'silverbullet')).fetchone()[0])['token']

# Verify an actual SDK tool write uses this tenant's space and a later read restores the same session.
status,conversation=api('/api/conversations',users[0]['token'],'POST',{'title':'虚构笔记工具验证'});assert status==201
modelpage='模型测试/'+secrets.token_hex(4)
status,run=api('/api/conversations/'+conversation['id']+'/runs',users[0]['token'],'POST',
 {'prompt':'必须调用 note_write 创建笔记 '+modelpage+'，内容必须是 FAKE_MODEL_NOTE_OK。创建成功后只回复完成。'});assert status==202
for _ in range(130):
 _,outcome=api('/api/runs/'+run['id'],users[0]['token'])
 if outcome['status'] not in ['queued','running']:break
 time.sleep(1)
assert outcome['status']=='completed', outcome.get('error')
status,note=api('/api/notes/'+urllib.parse.quote(modelpage,safe=''),users[0]['token']);assert status==200 and 'FAKE_MODEL_NOTE_OK' in note['content']
assert api('/api/notes/'+urllib.parse.quote(modelpage,safe=''),users[1]['token'])[0]==404
_,trace=api('/api/runs/'+run['id']+'/trace',users[0]['token'])
assert any(e['kind']=='sdk_event' and e['payload'].get('type')=='tool_execution_start' and e['payload'].get('toolName')=='note_write' for e in trace['events'])
assert api('/api/runs/'+run['id']+'/trace',users[1]['token'])[0]==404
print(json.dumps({'real_sb_isolation':True,'revision_conflicts':True,'real_sdk_note_tool':True}),flush=True)

status,qr=api('/api/admin/users/'+users[1]['id']+'/wechat/login',admin,'POST',{})
assert status==201, qr
assert qr['image'].startswith('data:image/png;base64,') and 'qr_token' not in qr and 'token' not in qr
assert api('/api/admin/users/'+users[0]['id']+'/wechat/login/'+qr['id'],admin)[0]==404
assert api('/api/admin/users/'+users[1]['id']+'/wechat/login/'+qr['id'],admin,'DELETE',{})[0]==200
_,cancelled=api('/api/admin/users/'+users[1]['id']+'/wechat/login/'+qr['id'],admin);assert cancelled['status']=='cancelled'
assert db.execute('SELECT count(*) FROM wechat_bindings').fetchone()[0]==0
report={'real_silverbullet_private_spaces':True,'agent_cross_space_denied':True,'tenant_notes_isolated':True,'etag_conflicts_enforced':True,
 'reprovision_keeps_token':True,'real_sdk_note_write':True,'cross_trace_denied':True,'real_wechat_qr_generated':True,
 'qr_wrong_tenant_denied':True,'qr_cancelled':True,'wechat_confirmation_and_delivery':'pending_independent_test_account_scan',
 'production_trace_http':urllib.request.urlopen('http://127.0.0.1:32213',timeout=5).status}
assert report['production_trace_http']==200
Path('/home/admin/.local/share/pi-agent-multi-tenant-dev/stage2-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
