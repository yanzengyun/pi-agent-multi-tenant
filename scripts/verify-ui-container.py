"""Use a disposable public Playwright image; clean synthetic server users afterward."""
import subprocess
import sys
from pathlib import Path

workspace = Path(__file__).resolve().parents[2]
name = 'pi-admin-browser-check'
def run(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, capture_output=True, **kwargs)
fixture = Path('/tmp/pi-admin-check-user.json')
if fixture.exists():
    subprocess.run([sys.executable, str(Path(__file__).with_name('cleanup-ui-probe.py'))], check=True)
try:
    run('create', '--name', name, '--memory', '512m', '--shm-size', '128m', '--entrypoint', 'sh',
        'mcr.microsoft.com/playwright:v1.55.0-noble', '-c', 'sleep 240')
    run('start', name)
    run('exec', name, 'mkdir', '-p', '/app/pi-agent-multi-tenant/scripts', '/app/alibaba_host/config', '/tmp/pi-backend-browser/node_modules')
    for filename in ['apps-login.json', 'multi-tenant-login.json']:
        run('cp', str(workspace/'alibaba_host/config'/filename), name+':/app/alibaba_host/config/'+filename)
    run('cp', str(Path(__file__).with_name('verify-ui.mjs')), name+':/app/pi-agent-multi-tenant/scripts/verify-ui.mjs')
    run('cp', '/tmp/pi-backend-browser/node_modules/playwright-core', name+':/tmp/pi-backend-browser/node_modules/playwright-core')
    binary = run('exec', name, 'sh', '-c', 'ls /ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell', text=True).stdout.strip()
    assert binary.startswith('/ms-playwright/')
    result = subprocess.run(['docker', 'exec', '-w', '/app/pi-agent-multi-tenant', '-e', 'PI_BROWSER_BINARY='+binary,
        name, 'node', 'scripts/verify-ui.mjs'], capture_output=True, text=True)
    for filename in ['pi-admin-check-user.json', 'pi-admin-ready.png']:
        subprocess.run(['docker', 'cp', name+':/tmp/'+filename, '/tmp/'+filename], capture_output=True)
    print(result.stdout); print(result.stderr)
    raise SystemExit(result.returncode)
finally:
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
    if fixture.exists():
        subprocess.run([sys.executable, str(Path(__file__).with_name('cleanup-ui-probe.py'))], check=True)
