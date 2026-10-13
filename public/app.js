const $ = selector => document.querySelector(selector);
async function api(path, method = 'GET', value) {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function notice(message) { $('#notice').textContent = message; }
async function showConsole() {
  const me = await api('/api/me');
  if (me.role !== 'admin') throw new Error('只有管理员可以使用此管理台');
  const data = await api('/api/admin/users');
  $('#login').hidden = true; $('#console').hidden = false;
  $('#mode').textContent = data.mode === 'mock' ? '测试模式：不调用真实模型' : 'Pi SDK：真实模型模式';
  $('#users').replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('article');
    const name = document.createElement('strong'); name.textContent = user.username;
    const detail = document.createElement('span'); detail.textContent = user.role === 'admin' ? '管理员' : '普通用户 · 微信未绑定';
    row.append(name, detail); $('#users').append(row);
  }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.target);
  try { await api('/api/login', 'POST', Object.fromEntries(form)); $('#login-form').reset(); await showConsole(); notice(''); }
  catch (error) { notice(error.message); }
});
$('#user-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/admin/users', 'POST', Object.fromEntries(new FormData(event.target))); event.target.reset(); await showConsole(); notice('用户已创建，私人数据独立保存。'); }
  catch (error) { notice(error.message); }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST', {}); location.reload(); } catch (error) { notice(error.message); }
});
showConsole().catch(() => {});
