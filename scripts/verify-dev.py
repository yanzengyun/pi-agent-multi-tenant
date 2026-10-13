"""Run ON SERVER: fake users only; no real personal chat or memory is read."""
import hashlib, json, secrets, time, urllib.request, urllib.error, subprocess
from pathlib import Path

base = 'http://127.0.0.1:32214'
def api(path, token=None, method='GET', data=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base + path, headers=headers, method=method,
        data=json.dumps(data).encode() if data is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

login = json.loads(Path('/home/admin/.config/pi-agent-multi-tenant-dev/login.json').read_text())
status, auth = api('/api/login', method='POST', data=login)
assert status == 200
admin = auth['token']
users = []
for label in ['alice', 'bob']:
    username = 'test_' + label + '_' + secrets.token_hex(3)
    password = secrets.token_urlsafe(24)
    status, user = api('/api/admin/users', admin, 'POST', {'username': username, 'password': password})
    assert status == 201
    status, auth = api('/api/login', method='POST', data={'username': username, 'password': password})
    assert status == 200
    token = auth['token']; canary = 'FAKE_' + label.upper() + '_' + secrets.token_hex(4)
    assert api('/api/memory', token, 'PUT', {'content': '测试代号：' + canary})[0] == 200
    status, conversation = api('/api/conversations', token, 'POST', {'title': '虚构隔离测试'})
    assert status == 201
    users.append({'token': token, 'id': user['id'], 'conversation': conversation['id'], 'canary': canary})

def run(user, prompt):
    status, result = api('/api/conversations/' + user['conversation'] + '/runs', user['token'], 'POST', {'prompt': prompt})
    assert status == 202
    deadline = time.monotonic() + 130
    while time.monotonic() < deadline:
        _, outcome = api('/api/runs/' + result['id'], user['token'])
        if outcome['status'] not in ['queued', 'running']:
            assert outcome['status'] == 'completed', outcome.get('error')
            return result['id'], outcome['response']
        time.sleep(1)
    raise AssertionError('Model run timed out')

report = {'health': api('/health')[1], 'users': 2, 'runs': []}
for index, user in enumerate(users):
    run_id, answer = run(user, '必须调用 memory_read 读取我的记忆，然后只输出其中的测试代号。')
    assert user['canary'] in answer and users[1-index]['canary'] not in answer
    _, trace = api('/api/runs/' + run_id + '/trace', user['token'])
    assert any(event['kind'] == 'context' and user['canary'] in event['payload']['system'] for event in trace['events'])
    tool_calls = [event['payload'].get('toolName') for event in trace['events']
        if event['kind'] == 'sdk_event' and event['payload'].get('type') == 'tool_execution_start']
    assert 'memory_read' in tool_calls
    assert api('/api/runs/' + run_id + '/trace', users[1-index]['token'])[0] == 404
    report['runs'].append({'memory_tool_called': True, 'own_canary_only': True, 'cross_trace_denied': True})
    print(json.dumps({'verified_user': index + 1, 'memory_and_trace_isolated': True}), flush=True)

run_id, answer = run(users[0], '从我们这个对话前面的消息中找到测试代号，不要调用工具，直接输出。')
assert users[0]['canary'] in answer and users[1]['canary'] not in answer
report['sdk_history_restored'] = True
print(json.dumps({'sdk_history_restored': True}), flush=True)

run_id, _ = run(users[1], '必须调用 web_search 搜索 Pi coding agent official documentation，然后报告结果数量并提供一个来源链接。')
_, trace = api('/api/runs/' + run_id + '/trace', users[1]['token'])
assert any(event['kind'] == 'sdk_event' and event['payload'].get('type') == 'tool_execution_start'
    and event['payload'].get('toolName') == 'web_search' for event in trace['events'])
report['real_web_search'] = True

before = json.loads(Path('/home/admin/.local/share/pi-agent-multi-tenant-dev/production-before.json').read_text())
after = {'hashes': {file: hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in before['hashes']},
    'pane_pid': subprocess.check_output(['runuser', '-u', 'admin', '--', 'tmux', 'display-message', '-p', '-t', 'pi-wechat', '#{pane_pid}'], text=True).strip()}
report['production_config_and_process_unchanged'] = before == after
assert report['production_config_and_process_unchanged']
report['production_trace_http'] = urllib.request.urlopen('http://127.0.0.1:32213', timeout=5).status
assert report['production_trace_http'] == 200
Path('/home/admin/.local/share/pi-agent-multi-tenant-dev/verification.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report), flush=True)
