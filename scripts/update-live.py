"""Update live code including changed locked dependencies; back up and preserve user identities."""
import ast
import io
import subprocess
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ssh = ['ssh','-i',str(root.parent/'alibaba_host/config/pic.pem'),'-o','IdentitiesOnly=yes',
       '-o','UserKnownHostsFile=/tmp/stockclaw-known-hosts','-o','BatchMode=yes','-o','ConnectTimeout=10']
ssh += ['-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','root@123.56.157.198']
deployment = ast.parse((root/'scripts/deploy-live.py').read_text())
remote = next(node.value.value for node in deployment.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='remote' for t in node.targets))
nginx = next(node.value.value for node in ast.parse(remote).body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='text' for t in node.targets))
prepare = r'''
import subprocess,sqlite3,json,tarfile,time,hashlib,shutil
from pathlib import Path
db=Path('/home/admin/.local/share/pi-agent-multi-tenant/data/assistant.sqlite')
if not shutil.which('rg'):raise SystemExit('Install ripgrep before deploying note_search')
c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
try:
 if c.execute("SELECT count(*) FROM runs WHERE status IN ('queued','running')").fetchone()[0]:raise SystemExit('Pending model runs; retry after they finish')
finally:c.close()
subprocess.run(['systemctl','stop','pi-multi-tenant'],check=True)
backup=Path('/home/admin/.local/share/pi-agent-multi-tenant/backups')/time.strftime('%Y%m%d-%H%M%S');backup.mkdir(mode=0o700,parents=True)
c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True);target=sqlite3.connect(str(backup/'assistant.sqlite'));c.backup(target);target.close()
before={'users':c.execute('SELECT id,username,password,role FROM users ORDER BY id').fetchall(),
 'bindings':c.execute('SELECT id,user_id,bot_id,remote_user,token,base_url,conversation_id FROM wechat_bindings ORDER BY id').fetchall(),
 'profiles':c.execute('SELECT user_id,content FROM agent_profiles ORDER BY user_id').fetchall(),
 'memories':c.execute('SELECT user_id,content FROM memories ORDER BY user_id').fetchall()}
digest=hashlib.sha256(json.dumps(before).encode()).hexdigest();c.close()
(backup/'identity-hash.txt').write_text(digest)
base=Path('/home/admin/pi-agent-multi-tenant-live')
with tarfile.open(backup/'code.tar.gz','w:gz') as tar:
 for name in ['src','public','scripts','sandbox','docs','README.md','HANDOFF.md','package.json','package-lock.json']:
  if (base/name).exists():tar.add(base/name,arcname=name)
route=Path('/etc/nginx/pi-app-routes.d/pi-multi-tenant.conf')
(backup/'nginx.conf').write_text(route.read_text())
(backup/'personal-pid.txt').write_text(subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','=pi-wechat:','#{pane_pid}'],text=True).strip())
for f in backup.iterdir():f.chmod(0o600)
subprocess.run(['chown','-R','admin:admin',str(backup)],check=True)
Path('/tmp/pi-multi-tenant-last-backup.txt').write_text(str(backup))
print('live_stopped_and_private_backup_saved')
'''
try:
    subprocess.run(ssh+['python3 -'],input=prepare,text=True,check=True)
except Exception:
    subprocess.run(ssh+['systemctl start pi-multi-tenant'],check=True)
    raise
archive=io.BytesIO()
with tarfile.open(fileobj=archive,mode='w:gz') as tar:
    for name in ['src','public','scripts','sandbox','docs','test','README.md','HANDOFF.md','package.json','package-lock.json']:tar.add(root/name,arcname=name)
try:
    subprocess.run(ssh+['tar -xzf - -C /home/admin/pi-agent-multi-tenant-live; chown -R admin:admin /home/admin/pi-agent-multi-tenant-live'],input=archive.getvalue(),check=True)
    dependencies = r'''
from pathlib import Path
import subprocess
backup=Path(Path('/tmp/pi-multi-tenant-last-backup.txt').read_text())
import tarfile
with tarfile.open(backup/'code.tar.gz') as tar:
 try: previous=tar.extractfile('package-lock.json').read()
 except KeyError: previous=None
base=Path('/home/admin/pi-agent-multi-tenant-live')
if previous != (base/'package-lock.json').read_bytes():
 subprocess.run(['runuser','-u','admin','--','npm','ci','--omit=peer','--ignore-scripts','--no-audit','--no-fund'],cwd=base,check=True)
print('locked_dependencies_ready')
'''
    subprocess.run(ssh+['python3 -'],input=dependencies,text=True,check=True)
    finish=r'''
import subprocess,json,sqlite3,hashlib,time,urllib.request
from pathlib import Path
backup=Path(Path('/tmp/pi-multi-tenant-last-backup.txt').read_text())
route=Path('/etc/nginx/pi-app-routes.d/pi-multi-tenant.conf');route.write_text(NGINX)
subprocess.run(['nginx','-t'],check=True,capture_output=True)
subprocess.run(['systemctl','start','pi-multi-tenant'],check=True)
for _ in range(40):
 try:
  with urllib.request.urlopen('http://127.0.0.1:32215/assistant/health',timeout=2) as r:assert json.load(r)['mode']=='pi'
  break
 except OSError:time.sleep(.5)
else:raise SystemExit('New backend failed health check')
subprocess.run(['systemctl','reload','nginx'],check=True)
c=sqlite3.connect('file:/home/admin/.local/share/pi-agent-multi-tenant/data/assistant.sqlite?mode=ro',uri=True)
after={'users':c.execute('SELECT id,username,password,role FROM users ORDER BY id').fetchall(),
 'bindings':c.execute('SELECT id,user_id,bot_id,remote_user,token,base_url,conversation_id FROM wechat_bindings ORDER BY id').fetchall(),
 'profiles':c.execute('SELECT user_id,content FROM agent_profiles ORDER BY user_id').fetchall(),
 'memories':c.execute('SELECT user_id,content FROM memories ORDER BY user_id').fetchall()};c.close()
assert hashlib.sha256(json.dumps(after).encode()).hexdigest()==(backup/'identity-hash.txt').read_text(),'Identity changed unexpectedly'
pid=subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','=pi-wechat:','#{pane_pid}'],text=True).strip();assert pid==(backup/'personal-pid.txt').read_text()
print(json.dumps({'live_updated':True,'existing_users_and_bindings_preserved':True,'custom_personas_preserved':True,'existing_memories_preserved':True,'personal_pid_unchanged':True,'backup':str(backup)}))
'''.replace('NGINX',repr(nginx))
    subprocess.run(ssh+['python3 -'],input=finish,text=True,check=True)
except Exception:
    rollback=r'''
from pathlib import Path
import subprocess,tarfile
backup=Path(Path('/tmp/pi-multi-tenant-last-backup.txt').read_text())
subprocess.run(['systemctl','stop','pi-multi-tenant'],check=True)
with tarfile.open(backup/'code.tar.gz') as tar:tar.extractall('/home/admin/pi-agent-multi-tenant-live')
subprocess.run(['runuser','-u','admin','--','npm','ci','--omit=peer','--ignore-scripts','--no-audit','--no-fund'],cwd='/home/admin/pi-agent-multi-tenant-live',check=True)
Path('/etc/nginx/pi-app-routes.d/pi-multi-tenant.conf').write_text((backup/'nginx.conf').read_text())
subprocess.run(['systemctl','start','pi-multi-tenant'],check=True)
subprocess.run(['nginx','-t'],check=True,capture_output=True);subprocess.run(['systemctl','reload','nginx'],check=True)
print('previous_code_and_routes_restored; database_not_overwritten')
'''
    subprocess.run(ssh+['python3 -'],input=rollback,text=True,check=True)
    raise
