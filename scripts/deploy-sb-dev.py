"""Create a separate, loopback-only SilverBullet dev instance. Never touches personal SB."""
import subprocess
from pathlib import Path

workspace = Path(__file__).resolve().parents[2]
remote = r'''
import json,secrets,subprocess,time,urllib.request
from pathlib import Path
private=Path('/home/admin/.config/pi-agent-multi-tenant-dev');private.mkdir(mode=0o700,exist_ok=True)
file=private/'silverbullet.json'
if not file.exists():
 file.write_text(json.dumps({'baseUrl':'http://127.0.0.1:32216','publicUrl':'http://127.0.0.1:32216','username':'pi-dev-admin','password':secrets.token_urlsafe(24)}));file.chmod(0o600)
 subprocess.run(['chown','admin:admin',str(file)],check=True)
config=json.loads(file.read_text());state=Path('/opt/pi-agent-multi-tenant-sb-dev/data')
state.mkdir(parents=True,mode=0o700,exist_ok=True);subprocess.run(['chown','10001:10001',str(state)],check=True)
name='silverbullet-multi-tenant-dev'
exists=subprocess.run(['docker','inspect',name],capture_output=True).returncode==0
if not exists:
 subprocess.run(['docker','run','-d','--name',name,'--restart','unless-stopped','--memory','128m','--cpus','0.25',
  '-e','PUID=10001','-e','PGID=10001','-e','SB_RUNTIME_API=0','-p','127.0.0.1:32216:3000',
  '-v',str(state)+':/data','ghcr.io/silverbulletmd/silverbullet:2.12.0-slim'],capture_output=True,check=True)
else:subprocess.run(['docker','start',name],capture_output=True,check=True)
for _ in range(40):
 try:
  with urllib.request.urlopen(config['baseUrl']+'/.instance',timeout=3) as response:instance=json.load(response)
  break
 except OSError:time.sleep(.5)
else:raise SystemExit('Dev SilverBullet did not start')
if not (state/'users.json').exists():
 payload={'primaryUrl':config['baseUrl'],'adminUsername':config['username'],'adminPassword':config['password'],
  'space':{'name':'开发验证','prefix':'/bootstrap','folder':'spaces/bootstrap','revisions':'disabled'}}
 request=urllib.request.Request(config['baseUrl']+'/.setup/api/complete',method='POST',headers={'Content-Type':'application/json'},data=json.dumps(payload).encode())
 with urllib.request.urlopen(request,timeout=60) as response:assert json.load(response)['status']=='ok'
print(json.dumps({'container':name,'loopback_port':32216,'version':instance.get('version'),'private_config':str(file)}))
'''
subprocess.run(['ssh','-i',str(workspace/'alibaba_host/config/pic.pem'),'-o','IdentitiesOnly=yes',
 '-o','UserKnownHostsFile=/tmp/stockclaw-known-hosts','-o','BatchMode=yes','-o','ConnectTimeout=10',
 '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','root@123.56.157.198','python3 -'],input=remote,text=True,check=True)
