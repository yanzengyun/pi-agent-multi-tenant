// Run as admin with the sandbox-client group. Creates/deletes only its own unbound synthetic user.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';
import { Sandbox } from '../src/sandbox.mjs';
import { hashPassword, tokenHash } from '../src/auth.mjs';
const store = new Store('/home/admin/.local/share/pi-agent-multi-tenant/data');
const sb = new SilverBullet(store, JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/silverbullet.json')));
const sandbox = new Sandbox('/run/pi-sandbox/runner.sock');
const login = JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/login.json'));
const base = 'http://127.0.0.1:32215/assistant';
async function api(path, token, method = 'GET', data) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
}
let user, adminToken, removed = false;
try {
  const auth = await api('/api/login', null, 'POST', login); assert.equal(auth.status, 200); adminToken = auth.data.token;
  const status = await sandbox.call('/status', {}); assert.ok(status.allocated < status.capacity, 'No free synthetic sandbox slot');
  const password = 'fake-deletion-password-' + randomUUID();
  user = store.createUser('verify_delete_' + Date.now(), await hashPassword(password));
  await sb.setUnifiedLogin(user, password);
  await sb.file(user.id, 'deletion-check', { method: 'PUT', content: 'FAKE_DELETION_NOTE_ARCHIVE' });
  const state = store.integration(user.id, 'silverbullet').state;
  const oldSession = randomUUID(); store.createToken(tokenHash(oldSession), user.id);
  const executed = await sandbox.tools(user.id).execute('printf FAKE_DELETION_SLOT > /work/deletion-check.txt');
  assert.equal(executed.exitCode, 0);
  assert.equal((await sandbox.call('/status', {})).allocated, status.allocated + 1);
  const deleted = await api('/api/admin/users/' + user.id, adminToken, 'DELETE', { confirmUsername: user.username });
  assert.equal(deleted.status, 200); assert.equal(deleted.data.notesArchived, true); removed = true;
  assert.equal(store.userById(user.id), undefined); assert.equal(store.principal(tokenHash(oldSession)), undefined);
  assert.equal((await sandbox.call('/status', {})).allocated, status.allocated);
  const archived = await sb.admin('spaces/' + state.spaceId); assert.deepEqual(archived.members || {}, {}); assert.equal(archived.access, 'none');
  const accounts = await sb.admin('users'); assert.equal(accounts[state.humanUsername], undefined); assert.equal(accounts[state.agentUsername], undefined);
  const oldNote = await fetch(sb.base + state.prefix + '/.fs/deletion-check.md', { headers: { Authorization: 'Bearer ' + state.token } });
  assert.ok([401,403,404].includes(oldNote.status));
  const report = { testedAt: new Date().toISOString(), syntheticUserId: user.id, realSandboxAllocationReleased: true,
    oldSessionRevoked: true, noteArchiveNoMembers: true, noteAccountsRemoved: true, oldAgentNoteAccessDenied: true, realUsersDeleted: false };
  writeFileSync('/tmp/pi-deletion-live-report.json', JSON.stringify(report), { mode: 0o600 }); console.log(JSON.stringify(report));
} finally {
  if (user && !removed && store.userById(user.id)) {
    if (!user.username.startsWith('verify_delete_') || store.wechatBinding(user.id)) throw new Error('Unsafe fixture cleanup');
    const cleanup = await api('/api/admin/users/' + user.id, adminToken, 'DELETE', { confirmUsername: user.username });
    if (cleanup.status !== 200) console.log(JSON.stringify({ syntheticCleanupPending: true, syntheticUserId: user.id }));
  }
  if (adminToken) await api('/api/logout', adminToken, 'POST', {});
  await sb.close(); store.close();
}
