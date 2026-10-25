"""Deploy the reviewed reminder fix, preserving identities and the personal assistant.

Tests only isolated fixtures. No synthetic WeChat messages or historical replay.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FILES = ['src/store.mjs', 'src/reminders.mjs', 'src/wechat.mjs', 'src/pi-engine.mjs', 'public/app.js']
TESTS = ['test/reminders.test.mjs', 'test/wechat.test.mjs', 'test/speech.test.mjs']
payload = {'files': {name: (ROOT/name).read_text() for name in FILES + TESTS},
           'expected': {name: hashlib.sha256(subprocess.check_output(['git', 'show', 'HEAD:'+name], cwd=ROOT)).hexdigest() for name in FILES},
           'production_files': FILES}
parser = argparse.ArgumentParser()
parser.add_argument('--expected-manifest', type=Path, help='Previously verified live file hashes for a follow-up deployment')
args = parser.parse_args()
if args.expected_manifest:
    payload['expected'] = json.loads(args.expected_manifest.read_text())
    assert set(payload['expected']) == set(FILES)
REMOTE = r'''
import datetime,hashlib,json,os,pathlib,pwd,shutil,sqlite3,subprocess,sys,tempfile,time,urllib.request
x=json.load(sys.stdin);base=pathlib.Path('/home/admin/pi-agent-multi-tenant-live')
data=pathlib.Path('/home/admin/.local/share/pi-agent-multi-tenant');db=data/'data/assistant.sqlite'
u=pwd.getpwnam('admin')
def digest(c):
 value={name:c.execute(sql).fetchall() for name,sql in {
 'users':'SELECT id,username,password,role FROM users ORDER BY id',
 'bindings':'SELECT id,user_id,bot_id,remote_user,token,base_url,conversation_id FROM wechat_bindings ORDER BY id',
 'profiles':'SELECT user_id,content FROM agent_profiles ORDER BY user_id',
 'memories':'SELECT user_id,content FROM memories ORDER BY user_id'}.items()}
 return hashlib.sha256(json.dumps(value).encode()).hexdigest()
def connect():return sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
for name,expected in x['expected'].items():
 assert hashlib.sha256((base/name).read_bytes()).hexdigest()==expected, 'Live file changed: '+name
# All test databases and HTTP clients are temporary mocks; use the installed dependencies.
with tempfile.TemporaryDirectory(prefix='reminder-repair-',dir=data) as folder:
 stage=pathlib.Path(folder);stage.chmod(0o755)
 shutil.copytree(base/'src',stage/'src');(stage/'node_modules').symlink_to(base/'node_modules',target_is_directory=True)
 for name,body in x['files'].items():
  p=stage/name;p.parent.mkdir(exist_ok=True,parents=True);p.write_text(body);p.chmod(0o644)
 subprocess.run(['chown','-R','admin:admin',str(stage/'src'),str(stage/'test')],check=True)
 for name in x['production_files']:
  if name.endswith('.mjs') or name.endswith('.js'):
   subprocess.run(['/usr/local/bin/node','--check',str(stage/name)],check=True)
 subprocess.run(['runuser','-u','admin','--','/usr/local/bin/node','--test',*[str(stage/n) for n in x['files'] if n.startswith('test/')]],cwd=stage,check=True)
c=connect()
assert not c.execute("SELECT count(*) FROM runs WHERE status IN ('queued','running')").fetchone()[0], 'Model jobs active; retry later'
c.close()
pid=subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','pi-wechat','#{pane_pid}'],text=True).strip()
backup=data/'backups'/('reminder-delivery-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700,parents=True)
subprocess.run(['systemctl','stop','pi-multi-tenant'],check=True)
try:
 c=connect();before=digest(c);target=sqlite3.connect(backup/'assistant.sqlite');c.backup(target);target.close();c.close()
 for name in x['production_files']:
  p=backup/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(base/name,p)
 (backup/'identity-sha256.txt').write_text(before)
 c=sqlite3.connect(db)
 c.execute('CREATE TABLE IF NOT EXISTS reminder_schedules (reminder_id TEXT PRIMARY KEY, weekdays_only INTEGER NOT NULL DEFAULT 0)')
 rows=c.execute("SELECT r.id,r.next_at FROM reminders r JOIN users u ON u.id=r.user_id WHERE u.username='bob' AND r.repeat_daily=1 AND r.status='scheduled' AND r.text LIKE '%工作日%'").fetchall()
 assert len(rows)==9, 'Expected nine explicitly labelled Bob weekday reminders'
 (backup/'bob-schedule-before.json').write_text(json.dumps(rows))
 for reminder,at in rows:
  c.execute('INSERT INTO reminder_schedules VALUES (?,1) ON CONFLICT(reminder_id) DO UPDATE SET weekdays_only=1',(reminder,))
  while datetime.datetime.fromtimestamp(at/1000,datetime.timezone(datetime.timedelta(hours=8))).weekday()>=5:at+=86400000
  c.execute('UPDATE reminders SET next_at=? WHERE id=?',(at,reminder))
 c.commit();c.close()
 for name in x['production_files']:
  p=base/name;tmp=p.with_suffix(p.suffix+'.reminder-new');tmp.write_text(x['files'][name]);tmp.chmod(0o644);os.chown(tmp,u.pw_uid,u.pw_gid);tmp.replace(p)
 for p in backup.rglob('*'):
  if p.is_file():p.chmod(0o600)
 subprocess.run(['chown','-R','admin:admin',str(backup)],check=True)
 subprocess.run(['systemctl','start','pi-multi-tenant'],check=True)
 for _ in range(40):
  try:
   with urllib.request.urlopen('http://127.0.0.1:32215/assistant/health',timeout=2) as response:
    assert json.load(response)['mode']=='pi'
   break
  except OSError:time.sleep(.5)
 else:raise RuntimeError('Health check failed')
 c=connect();assert digest(c)==before,'Identity/persona/memory changed';c.close()
 assert subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','pi-wechat','#{pane_pid}'],text=True).strip()==pid
 print(json.dumps({'deployed':True,'backup':str(backup),'bob_weekday_reminders':len(rows),'identities_and_memories_preserved':True,'personal_pid_unchanged':True}))
except BaseException:
 subprocess.run(['systemctl','stop','pi-multi-tenant'],check=False)
 for name in x['production_files']:
  if (backup/name).exists():shutil.copy2(backup/name,base/name);os.chown(base/name,u.pw_uid,u.pw_gid)
 subprocess.run(['systemctl','start','pi-multi-tenant'],check=False)
 print('Deployment failed; previous code restored. Database backup and schedule snapshot retained.',file=sys.stderr)
 raise
'''
command = ['ssh', '-i', str(ROOT.parent/'alibaba_host/config/pic.pem'),
           '-o', 'UserKnownHostsFile='+str(ROOT.parent/'alibaba_host/config/known_hosts'),
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
           'root@123.56.157.198', 'python3 -c '+shlex.quote(REMOTE)]
raise SystemExit(subprocess.run(command, input=json.dumps(payload), text=True).returncode)
