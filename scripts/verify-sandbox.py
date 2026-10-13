"""Run on the server. All workspace probes use synthetic UUIDs and are released."""
import http.client
import json
import socket
import statistics
import threading
import time
import uuid
from pathlib import Path

SOCKET = '/run/pi-sandbox/runner.sock'
class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(40)
        self.sock.connect(SOCKET)

def call(path, data):
    connection = Connection('localhost')
    connection.request('POST', path, json.dumps(data), {'Content-Type': 'application/json'})
    response = connection.getresponse()
    result = json.load(response)
    connection.close()
    assert response.status == 200, result
    return result

def execute(user, command, request_id=None):
    return call('/execute', {'userId':user, 'requestId':request_id or str(uuid.uuid4()), 'command':command})

users = [str(uuid.uuid4()), str(uuid.uuid4())]
fixture=Path('/tmp/pi-sandbox-verification-users.json')
fixture.write_text(json.dumps(users));fixture.chmod(0o600)
report = {}
try:
    a,b=users
    first=execute(a,'printf FAKE_ALICE > note; python3 -c "print(2+3)"')
    assert first['exitCode']==0 and not first['workspaceReused']
    second=execute(a,'cat note')
    assert second['stdout']=='FAKE_ALICE' and second['workspaceReused']
    isolated=execute(b,'test ! -e note && test ! -e /home/admin && test ! -e /var/lib/pi-sandbox && test ! -e /run/pi-sandbox/runner.sock && echo ISOLATED')
    assert isolated['stdout']=='ISOLATED\n'
    report['workspace_reuse_and_cross_user_isolation']=True
    denied=execute(a,"python3 -c \"import os,socket; assert 'MINIMAX_CN_API_KEY' not in os.environ; socket.socket()\"")
    assert denied['exitCode']!=0 and 'Operation not permitted' in denied['stderr']
    report['network_and_host_secrets_blocked']=True
    symlink=execute(a,'ln -s /home/admin escape; test ! -e escape/.config && echo LINK_BLOCKED')
    assert 'LINK_BLOCKED' in symlink['stdout']
    report['symlink_escape_blocked']=True
    output=execute(a,"python3 -c \"print('x'*1000000)\"")
    assert output['reason']=='output_limit' and len(output['stdout'].encode())+len(output['stderr'].encode())<=32768
    report['output_limit']=True
    memory=execute(a,"python3 -c \"x=bytearray(300*1024*1024)\"")
    assert memory['reason']=='memory_limit', memory
    report['memory_limit']=True
    processes=execute(a,"python3 - <<'PY'\nimport os,time,signal\nchildren=[]\ntry:\n for _ in range(100):\n  pid=os.fork()\n  if pid==0:time.sleep(10);os._exit(0)\n  children.append(pid)\nexcept OSError as e:\n assert e.errno==11,e\n print('PID_LIMIT')\nfinally:\n for pid in children:os.kill(pid,signal.SIGTERM)\n for pid in children:os.waitpid(pid,0)\nPY")
    assert processes['exitCode']==0 and 'PID_LIMIT' in processes['stdout'],processes
    report['process_limit']=True

    disk=execute(a,"python3 - <<'PY'\nimport errno\ntry:\n for i in range(20):\n  with open('fill'+str(i),'wb') as f:f.write(b'x'*(10*1024*1024))\nexcept OSError as e:\n assert e.errno==errno.ENOSPC,e\n print('DISK_LIMIT')\nPY")
    assert disk['exitCode']==0 and 'DISK_LIMIT' in disk['stdout'], disk
    assert execute(a,'rm -f fill*')['exitCode']==0
    report['disk_limit']=True
    nonce=str(uuid.uuid4()); result=[]
    worker=threading.Thread(target=lambda:result.append(execute(a,'sleep 60',nonce)))
    worker.start();time.sleep(.5);call('/cancel',{'userId':a,'requestId':nonce});worker.join(5)
    assert not worker.is_alive() and result[0]['reason']=='cancelled'
    report['cancellation']=True
    nonce=str(uuid.uuid4());call('/cancel',{'userId':a,'requestId':nonce})
    assert execute(a,'echo SHOULD_NOT_RUN',nonce)['reason']=='cancelled'
    report['cancel_before_start']=True
    timeout=execute(a,'sleep 60')
    assert timeout['reason']=='timed_out' and timeout['durationMs']<33000
    report['timeout']=True
    background=execute(a,'sleep 60 >/dev/null 2>&1 & echo FAKE_CHILD')
    assert background['reason']=='completed' and background['exitCode']==0
    report['background_children_cleaned']=True
    timings=[execute(a,'true')['durationMs'] for _ in range(5)]
    report['median_command_ms']=statistics.median(timings)
    report['pool']=call('/status',{})
finally:
    for user in users:call('/release',{'userId':user})
    fixture.unlink()
report['pool']=call('/status',{})
assert not report['pool']['active']
assert not list(Path('/sys/fs/cgroup/system.slice/pi-sandbox.service').glob('task-*'))
report['no_residual_task_cgroups']=True
print(json.dumps(report))
