"""Install an independent low-privilege runner and a bounded persistent workspace pool."""
import io
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parents[1]
ssh = ['ssh', '-i', str(root.parent / 'alibaba_host/config/pic.pem'), '-o', 'IdentitiesOnly=yes',
       '-o', 'UserKnownHostsFile=/tmp/stockclaw-known-hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
       '-o', 'ServerAliveInterval=10', 'root@123.56.157.198']
prepare = r'''
from pathlib import Path
import grp,pwd,subprocess,time

def run(*args):subprocess.run(args,check=True,capture_output=True)
run('apt-get','install','-y','--no-install-recommends','bubblewrap','libseccomp2')
try:grp.getgrnam('pi-sandbox-client')
except KeyError:run('groupadd','--system','pi-sandbox-client')
try:pwd.getpwnam('pi-sandbox')
except KeyError:run('useradd','--system','--gid','pi-sandbox-client','--no-create-home','--shell','/usr/sbin/nologin','pi-sandbox')
profile=Path('/etc/apparmor.d/pi-sandbox-bwrap')
policy='abi <abi/4.0>,\ninclude <tunables/global>\nprofile pi-sandbox-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n'
if profile.exists() and profile.read_text()!=policy:raise SystemExit('Existing AppArmor policy differs; preserve it')
profile.write_text(policy);run('apparmor_parser','-r',str(profile))
Path('/opt/pi-sandbox/code').mkdir(parents=True,exist_ok=True)
Path('/opt/pi-sandbox/disks').mkdir(mode=0o700,parents=True,exist_ok=True)
slots=Path('/var/lib/pi-sandbox/slots');slots.mkdir(mode=0o700,parents=True,exist_ok=True)
run('chown','pi-sandbox:pi-sandbox-client',str(slots))
fstab=Path('/etc/fstab');old=fstab.read_text();new=old
for index in range(8):
 disk=Path('/opt/pi-sandbox/disks')/f'slot-{index}.img';mount=slots/str(index);mount.mkdir(mode=0o700,exist_ok=True)
 if not disk.exists():
  with disk.open('wb') as f:f.truncate(128*1024*1024)
  disk.chmod(0o600)
  run('mkfs.ext4','-q','-F','-m','0',str(disk))
 line=f'{disk} {mount} ext4 loop,nodev,nosuid,nofail 0 0\n'
 if line not in new:
  if any(str(mount) in l for l in old.splitlines() if l.strip() and not l.lstrip().startswith('#')):raise SystemExit('Existing mount entry differs')
  new+=line
 if not subprocess.run(['mountpoint','-q',str(mount)]).returncode:pass
 else:run('mount','-o','loop,nodev,nosuid',str(disk),str(mount))
 work=mount/'work';work.mkdir(mode=0o700,exist_ok=True)
 run('chown','pi-sandbox:pi-sandbox-client',str(work))
if new!=old:
 backup=Path('/root/pi-sandbox-backups');backup.mkdir(mode=0o700,exist_ok=True)
 (backup/('fstab-'+time.strftime('%Y%m%d-%H%M%S'))).write_text(old)
 fstab.write_text(new)
print('sandbox_user_and_workspace_pool_prepared')
'''
subprocess.run(ssh + ['python3 -'], input=prepare, text=True, check=True)
subprocess.run(ssh + ['python3 -'], input="from pathlib import Path\nimport subprocess\nif list(Path('/sys/fs/cgroup/system.slice/pi-sandbox.service').glob('task-*')):raise SystemExit('Active sandbox tasks; retry later')\nsubprocess.run(['systemctl','stop','pi-sandbox'],check=True)\n", text=True, check=True)
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w:gz') as tar:
    for name in ['runner.py', 'task_entry.py']:tar.add(root/'sandbox'/name,arcname=name)
subprocess.run(ssh+['tar -xzf - -C /opt/pi-sandbox/code; chown -R root:root /opt/pi-sandbox/code; chmod 755 /opt/pi-sandbox/code; chmod 644 /opt/pi-sandbox/code/*.py'],input=archive.getvalue(),check=True)
finish = r'''
from pathlib import Path
import subprocess,time
unit=''' + repr('''[Unit]
Description=Pi isolated command runner
After=local-fs.target apparmor.service
RequiresMountsFor=/var/lib/pi-sandbox/slots/0 /var/lib/pi-sandbox/slots/1 /var/lib/pi-sandbox/slots/2 /var/lib/pi-sandbox/slots/3 /var/lib/pi-sandbox/slots/4 /var/lib/pi-sandbox/slots/5 /var/lib/pi-sandbox/slots/6 /var/lib/pi-sandbox/slots/7

[Service]
User=pi-sandbox
Group=pi-sandbox-client
ExecStart=/usr/bin/python3 /opt/pi-sandbox/code/runner.py
RuntimeDirectory=pi-sandbox
RuntimeDirectoryMode=0750
UMask=0077
Environment=PI_SANDBOX_POOL_SIZE=8
Delegate=cpu memory pids
MemoryMax=256M
MemorySwapMax=0
CPUQuota=50%
TasksMax=80
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/pi-sandbox /run/pi-sandbox
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
''') + r'''
Path('/etc/systemd/system/pi-sandbox.service').write_text(unit)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','pi-sandbox'],check=True,capture_output=True)
for _ in range(40):
 if Path('/run/pi-sandbox/runner.sock').exists():break
 time.sleep(.25)
else:raise SystemExit('Runner socket not ready; inspect journal')
print('sandbox_runner_started; backend_configuration_unchanged')
'''
subprocess.run(ssh+['python3 -'],input=finish,text=True,check=True)
