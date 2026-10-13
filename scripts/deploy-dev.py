"""Copy code only to an isolated, loopback-only development instance.

Run from the workspace. Requires the existing Alibaba SSH key path. Does not
reload production Pi, change its settings, or modify Nginx/SilverBullet.
"""
import io, subprocess, tarfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
workspace = root.parent
ssh = ['ssh', '-i', str(workspace/'alibaba_host/config/pic.pem'), '-o', 'IdentitiesOnly=yes',
       '-o', 'UserKnownHostsFile=/tmp/stockclaw-known-hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
       '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', 'root@123.56.157.198']
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as tar:
    for relative in ['src', 'public', 'test', 'package.json', 'package-lock.json', 'models.json', 'README.md', 'HANDOFF.md']:
        path = root/relative
        if path.exists(): tar.add(path, arcname=relative)
    for relative in ['sdk-runtime/package.json', 'sdk-runtime/package-lock.json']:
        tar.add(root/relative, arcname=relative)
subprocess.run(ssh + ['install -d -o admin -g admin -m 700 /home/admin/pi-agent-multi-tenant-dev && '
    'tar -xzf - -C /home/admin/pi-agent-multi-tenant-dev && '
    'chown -R admin:admin /home/admin/pi-agent-multi-tenant-dev'], input=archive.getvalue(), check=True)
remote = r'''
import subprocess,json,hashlib,secrets,shlex
from pathlib import Path
base=Path('/home/admin/.local/share/pi-agent-multi-tenant-dev');base.mkdir(mode=0o700,exist_ok=True)
private=Path('/home/admin/.config/pi-agent-multi-tenant-dev');private.mkdir(mode=0o700,exist_ok=True)
def baseline():
 paths=[Path('/home/admin/.pi/agent')/p for p in ['settings.json','models.json','state/scheduler/tasks.json']]
 return {'hashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},'pane_pid':subprocess.check_output(['runuser','-u','admin','--','tmux','display-message','-p','-t','pi-wechat','#{pane_pid}'],text=True).strip()}
f=base/'production-before.json'
f.write_text(json.dumps(baseline()));f.chmod(0o600)
login=private/'login.json'
if not login.exists():login.write_text(json.dumps({'username':'admin','password':secrets.token_urlsafe(24)}));login.chmod(0o600)
password=json.loads(login.read_text())['password']
protection=private/'wechat-protection.json'
existing=Path('/home/admin/.pi/agent/wechat-assistant/credentials.json')
identity=json.loads(existing.read_text()) if existing.exists() else {}
protection.write_text(json.dumps({'protectedBots':[identity['accountId']] if identity.get('accountId') else [],'protectedUsers':[identity['userId']] if identity.get('userId') else []}));protection.chmod(0o600)
extra='ASSISTANT_WECHAT=on\nASSISTANT_WECHAT_PROTECTION='+str(protection)+'\n'
if (private/'silverbullet.json').exists():extra+='ASSISTANT_SB_CONFIG='+str(private/'silverbullet.json')+'\n'
env=private/'env';env.write_text('ASSISTANT_ADMIN_PASSWORD='+shlex.quote(password)+'\nASSISTANT_DATA_DIR='+str(base/'data')+'\nASSISTANT_ENGINE=pi\nASSISTANT_PORT=32214\nPI_SDK_MODULE=/home/admin/pi-agent-multi-tenant-dev/sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js\nASSISTANT_SEARCH=on\n'+extra);env.chmod(0o600)
launcher=Path('/home/admin/pi-agent-multi-tenant-dev/start-dev.sh')
launcher.write_text('#!/bin/sh\nset -eu\numask 077\n. "$HOME/.config/pi-agent/env"\n. "$HOME/.config/pi-agent-multi-tenant-dev/env"\nexport MINIMAX_CN_API_KEY ASSISTANT_ADMIN_PASSWORD ASSISTANT_DATA_DIR ASSISTANT_ENGINE ASSISTANT_PORT PI_SDK_MODULE ASSISTANT_SEARCH ASSISTANT_WECHAT ASSISTANT_WECHAT_PROTECTION ASSISTANT_SB_CONFIG\ncd "$HOME/pi-agent-multi-tenant-dev"\nexec /usr/local/bin/node src/main.mjs\n');launcher.chmod(0o700)
subprocess.run(['runuser','-u','admin','--','npm','ci','--prefix','/home/admin/pi-agent-multi-tenant-dev','--omit=peer','--ignore-scripts','--no-audit','--no-fund'],check=True)
subprocess.run(['runuser','-u','admin','--','npm','ci','--prefix','/home/admin/pi-agent-multi-tenant-dev/sdk-runtime','--ignore-scripts','--no-audit','--no-fund'],check=True)
subprocess.run(['chown','-R','admin:admin',str(base),str(private),str(launcher)],check=True)
# Never touch the existing pi-wechat tmux session. Restart only this dev session.
if subprocess.run(['runuser','-u','admin','--','tmux','has-session','-t','pi-multi-tenant-dev'],capture_output=True).returncode==0:
 subprocess.run(['runuser','-u','admin','--','tmux','kill-session','-t','pi-multi-tenant-dev'],check=True)
subprocess.run(['runuser','-u','admin','--','tmux','new-session','-d','-s','pi-multi-tenant-dev',str(launcher)],check=True)
print(json.dumps({'deployed':'/home/admin/pi-agent-multi-tenant-dev','private_login_file':str(login),'loopback_port':32214,'production_unchanged':baseline()==json.loads(f.read_text())}))
'''
subprocess.run(ssh+['python3 -'],input=remote,text=True,check=True)
