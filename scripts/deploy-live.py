"""Deploy an independent live service behind the existing authenticated gateway."""
import io
import subprocess
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ssh = ['ssh', '-i', str(root.parent/'alibaba_host/config/pic.pem'), '-o', 'IdentitiesOnly=yes',
       '-o', 'UserKnownHostsFile=/tmp/stockclaw-known-hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
       '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', 'root@123.56.157.198']
preflight = r"""
import subprocess,sqlite3,shutil
from pathlib import Path
memory=dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
if not shutil.which('rg'):raise SystemExit('Install ripgrep before deploying note_search')
if int(memory['MemAvailable'].split()[0]) < 600*1024: raise SystemExit('Insufficient available memory; do not deploy')
database=Path('/home/admin/.local/share/pi-agent-multi-tenant/data/assistant.sqlite')
if subprocess.run(['systemctl','is-active','--quiet','pi-multi-tenant']).returncode==0:
 if database.exists():
  connection=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True)
  try:
   if connection.execute("SELECT count(*) FROM runs WHERE status IN ('queued','running')").fetchone()[0]:raise SystemExit('Assistant has pending runs; refusing redeploy')
  finally:connection.close()
 subprocess.run(['systemctl','stop','pi-multi-tenant'],check=True)
print('resource_preflight_ok')
"""
subprocess.run(ssh+['python3 -'], input=preflight, text=True, check=True)
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as tar:
    for name in ['src', 'public', 'test', 'scripts', 'package.json', 'package-lock.json', 'models.json', 'README.md', 'HANDOFF.md',
                 'sdk-runtime/package.json', 'sdk-runtime/package-lock.json']:
        tar.add(root/name, arcname=name)
subprocess.run(ssh+['umask 077; mkdir -p /home/admin/pi-agent-multi-tenant-live; tar -xzf - -C /home/admin/pi-agent-multi-tenant-live; chown -R admin:admin /home/admin/pi-agent-multi-tenant-live'], input=archive.getvalue(), check=True)
remote = r"""
import json,secrets,subprocess,time,urllib.request,hashlib
from pathlib import Path
base=Path('/home/admin/pi-agent-multi-tenant-live')
private=Path('/home/admin/.config/pi-agent-multi-tenant');private.mkdir(mode=0o700,exist_ok=True)
data=Path('/home/admin/.local/share/pi-agent-multi-tenant');data.mkdir(mode=0o700,exist_ok=True)
def personal():
 paths=[Path('/home/admin/.pi/agent')/n for n in ['settings.json','models.json','state/scheduler/tasks.json']]
 return {'hashes':[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths],
  'pid':subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','=pi-wechat:','#{pane_pid}'],text=True).strip()}
before=personal()
login=private/'login.json'
if not login.exists():
 login.write_text(json.dumps({'url':'https://123.56.157.198:32651/assistant/','username':'admin','password':secrets.token_urlsafe(24)}));login.chmod(0o600)
protection=private/'wechat-protection.json'
identity=json.loads(Path('/home/admin/.pi/agent/wechat-assistant/credentials.json').read_text())
protection.write_text(json.dumps({'protectedBots':[identity['accountId']] if identity.get('accountId') else [],'protectedUsers':[identity['userId']] if identity.get('userId') else []}));protection.chmod(0o600)
sbconfig=private/'silverbullet.json'
if not sbconfig.exists():
 sbconfig.write_text(json.dumps({'baseUrl':'http://127.0.0.1:32216','publicUrl':'https://123.56.157.198:32651','username':'pi-multi-admin','password':secrets.token_urlsafe(24)}));sbconfig.chmod(0o600)
sb=json.loads(sbconfig.read_text());state=Path('/opt/pi-agent-multi-tenant-sb/data');state.mkdir(mode=0o700,parents=True,exist_ok=True)
subprocess.run(['chown','10001:10001',str(state)],check=True)
name='silverbullet-multi-tenant'
if subprocess.run(['docker','inspect',name],capture_output=True).returncode:
 subprocess.run(['docker','run','-d','--name',name,'--restart','unless-stopped','--memory','128m','--cpus','0.25',
  '-e','PUID=10001','-e','PGID=10001','-e','SB_RUNTIME_API=0','-p','127.0.0.1:32216:3000','-v',str(state)+':/data',
  'ghcr.io/silverbulletmd/silverbullet:2.12.0-slim'],capture_output=True,check=True)
else:subprocess.run(['docker','start',name],capture_output=True,check=True)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(40):
 try:
  with opener.open(sb['baseUrl']+'/.instance',timeout=3) as response:json.load(response)
  break
 except OSError:time.sleep(.5)
else:raise SystemExit('Independent SilverBullet failed to start')
if not (state/'users.json').exists():
 payload={'primaryUrl':sb['publicUrl'],'adminUsername':sb['username'],'adminPassword':sb['password'],
  'space':{'name':'管理初始化','prefix':'/bootstrap','folder':'spaces/bootstrap','revisions':'disabled'}}
 request=urllib.request.Request(sb['baseUrl']+'/.setup/api/complete',method='POST',headers={'Content-Type':'application/json'},data=json.dumps(payload).encode())
 with opener.open(request,timeout=60) as response:assert json.load(response)['status']=='ok'
# The environment file stores paths, not model secrets. The launcher reads the existing private model environment.
env=private/'env'
env.write_text('ASSISTANT_DATA_DIR='+str(data/'data')+'\nASSISTANT_ENGINE=pi\nASSISTANT_PORT=32215\nASSISTANT_BASE_PATH=/assistant\nASSISTANT_ORIGIN=https://123.56.157.198:32651\nASSISTANT_SECURE_COOKIES=on\nASSISTANT_SEARCH=on\nASSISTANT_TTS=on\nASSISTANT_WECHAT=on\nASSISTANT_WECHAT_PROTECTION='+str(protection)+'\nASSISTANT_SB_CONFIG='+str(sbconfig)+'\n');env.chmod(0o600)
launcher=private/'start.sh'
launcher.write_text('#!/bin/sh\nset -eu\numask 077\nset -a\n. "$HOME/.config/pi-agent/env"\n. "$HOME/.config/pi-agent-multi-tenant/env"\nset +a\ncd "$HOME/pi-agent-multi-tenant-live"\nASSISTANT_ADMIN_PASSWORD=$(/usr/bin/python3 -c \'import json;print(json.load(open("/home/admin/.config/pi-agent-multi-tenant/login.json"))["password"])\')\nexport ASSISTANT_ADMIN_PASSWORD\nexec /usr/local/bin/node src/main.mjs\n');launcher.chmod(0o700)
subprocess.run(['chown','-R','admin:admin',str(private),str(data)],check=True)
for directory,args in [(str(base),['--omit=peer']),(str(base/'sdk-runtime'),[])]:
 subprocess.run(['runuser','-u','admin','--','npm','ci','--prefix',directory,*args,'--ignore-scripts','--no-audit','--no-fund'],check=True)
unit=Path('/etc/systemd/system/pi-multi-tenant.service')
unit.write_text('[Unit]\nDescription=Multi-user Pi assistant\nAfter=network-online.target docker.service\nWants=network-online.target\n\n[Service]\nUser=admin\nGroup=admin\nEnvironment=HOME=/home/admin\nWorkingDirectory='+str(base)+'\nExecStart='+str(launcher)+'\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=180\nMemoryHigh=256M\nMemoryMax=384M\nCPUQuota=50%\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n');unit.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','pi-multi-tenant'],check=True)
subprocess.run(['systemctl','restart','pi-multi-tenant'],check=True)
for _ in range(40):
 try:
  with opener.open('http://127.0.0.1:32215/assistant/health',timeout=3) as response:assert json.load(response)['mode']=='pi'
  break
 except OSError:time.sleep(.5)
else:raise SystemExit('Assistant failed health check')
route=Path('/etc/nginx/pi-app-routes.d/pi-multi-tenant.conf')
text='''location = /assistant { auth_basic off; return 302 /assistant/; }
location ^~ /assistant/ {
 # The assistant uses its own session login and server-side admin/user permissions.
 auth_basic off;
 proxy_pass http://127.0.0.1:32215;
 proxy_http_version 1.1;
 proxy_set_header Host $http_host;
 proxy_set_header X-Forwarded-Proto https;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header Authorization "";
 proxy_read_timeout 70s;
}
location ^~ /.auth/central/ {
 # Native SilverBullet login and assets use root URLs; user authentication stays in SilverBullet.
 auth_basic off;
 proxy_pass http://127.0.0.1:32216;
 proxy_set_header Host $http_host;
 proxy_set_header X-Forwarded-Proto https;
 proxy_set_header Authorization "";
}
location ^~ /users/ {
 # SilverBullet enforces each user's own password and Space permissions.
 auth_basic off;
 proxy_pass http://127.0.0.1:32216;
 proxy_http_version 1.1;
 proxy_set_header Host $http_host;
 proxy_set_header X-Forwarded-Proto https;
 proxy_set_header Authorization "";
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "upgrade";
 proxy_read_timeout 70s;
}
'''
old=route.read_text() if route.exists() else None
route.write_text(text)
try:subprocess.run(['nginx','-t'],check=True,capture_output=True)
except Exception:
 if old is None:route.unlink()
 else:route.write_text(old)
 raise
subprocess.run(['systemctl','reload','nginx'],check=True)
after=personal();assert before==after,'Personal configuration or process changed'
print(json.dumps({'url':'https://123.56.157.198:32651/assistant/','private_login_file':str(login),'personal_unchanged':True,'service':'pi-multi-tenant','memory_max':'384MiB'}))
"""
subprocess.run(ssh+['python3 -'],input=remote,text=True,check=True)
