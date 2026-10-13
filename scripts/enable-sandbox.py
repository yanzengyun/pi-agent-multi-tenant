"""Enable the verified runner for the next backend restart; does not restart personal Pi."""
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
ssh=['ssh','-i',str(root.parent/'alibaba_host/config/pic.pem'),'-o','IdentitiesOnly=yes',
     '-o','UserKnownHostsFile=/tmp/stockclaw-known-hosts','-o','BatchMode=yes','root@123.56.157.198']
code=r'''
import http.client,socket,json,subprocess
from pathlib import Path
class Connection(http.client.HTTPConnection):
 def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/run/pi-sandbox/runner.sock')
c=Connection('localhost');c.request('POST','/status','{}',{'Content-Type':'application/json'});r=c.getresponse();status=json.load(r);c.close()
assert r.status==200 and status['ready'] and not status['active'],'Runner is not idle/ready'
path=Path('/etc/systemd/system/pi-multi-tenant.service.d/10-sandbox.conf');path.parent.mkdir(exist_ok=True)
content='[Service]\nSupplementaryGroups=pi-sandbox-client\nEnvironment=ASSISTANT_SANDBOX_SOCKET=/run/pi-sandbox/runner.sock\n'
if path.exists() and path.read_text()!=content:raise SystemExit('Existing sandbox override differs; preserve it')
path.write_text(content)
subprocess.run(['systemctl','daemon-reload'],check=True)
print('sandbox_backend_configuration_ready; restart_via_update_live')
'''
subprocess.run(ssh+['python3 -'],input=code,text=True,check=True)
