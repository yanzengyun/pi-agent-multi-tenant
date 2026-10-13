const $ = selector => document.querySelector(selector);
const errors = { invalid_invite: '邀请已失效、被使用或撤销，请联系管理员获取新链接。', invite_username_mismatch: '请使用邀请指定的账号。',
  username_exists: '账号已存在，请换一个或获取原账号的激活邀请。', invalid_username: '账号只能包含字母、数字、下划线和短横线。',
  password_too_short: '密码至少需要12位。', invalid_credentials: '账号或密码不正确。', sb_username_conflict: '笔记用户名已被占用，请换一个。',
  sb_login_update_failed: '笔记登录信息更新失败，请稍后重试。', wrong_password: '当前密码不正确。', login_throttled: '请求较多，请稍后再试。' };
async function api(path, method = 'GET', data) {
  const r = await fetch(new URL('.' + path, document.baseURI), { method, credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await r.json(); if (!r.ok) throw new Error(errors[value.error] || value.error || '请求失败'); return value;
}
function notice(message) { $('#notice').textContent = message; }
function onForm(id, handler) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await handler(Object.fromEntries(new FormData(event.target))); }
    catch (error) { notice(error.message); } finally { button.disabled = false; }
  });
}
const statuses = { connected: '已连接', not_bound: '未连接', expired: '登录已过期，请解除连接后重新扫码', disabled: '未启用', ready: '已准备', not_provisioned: '尚未设置', failed: '准备失败', provisioning: '准备中' };
let attempt = null, timer, inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
async function loadAccount(refreshProfile = true) {
  const data = await api('/api/account');
  $('#register').hidden = true; $('#login').hidden = true; $('#account').hidden = false;
  $('#account-name').textContent = data.user.username;
  $('#wechat-state').textContent = statuses[data.wechat.status] || data.wechat.status;
  $('#wechat-bind').hidden = !['not_bound'].includes(data.wechat.status);
  $('#wechat-disconnect').hidden = !['connected','expired'].includes(data.wechat.status);
  $('#notes-state').textContent = (statuses[data.silverbullet.status] || data.silverbullet.status) + (data.silverbullet.status === 'ready' ? (data.silverbullet.passwordUnified ? ' · 密码与主页一致' : ' · 验证主页密码后可统一笔记密码') : '');
  $('#notes-form input[name=username]').value = data.silverbullet.username || data.user.username;
  $('#notes-link').hidden = !data.silverbullet.url;
  if (data.silverbullet.url) $('#notes-link').href = data.silverbullet.url;
  if (refreshProfile) $('#agents-content').value = (await api('/api/account/agents')).content;
}
onForm('#register-form', async data => {
  const result = await api('/api/register', 'POST', { ...data, invite: inviteToken });
  inviteToken = null; history.replaceState(null, '', new URL('account', document.baseURI));
  $('#register-form').reset(); notice(result.notesPending ? '账号已准备；笔记暂未同步，请在下方验证主页密码重试。' : '账号已准备，笔记共用登录密码，可以连接微信。'); await loadAccount();
});
onForm('#login-form', async data => { await api('/api/login', 'POST', data); $('#login-form').reset(); notice(''); await loadAccount(); });
onForm('#agents-form', async data => { await api('/api/account/agents', 'PUT', data); notice('人物设定已保存，后续对话生效。'); });
onForm('#persona-assist-form', async data => {
  const initialContent = $('#agents-content').value;
  const result = await api('/api/account/persona-assist', 'POST', data);
  notice('AI 正在生成草稿…');
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const run = await api('/api/account/persona-assist/' + result.id);
    if (run.status === 'completed') {
      if (!run.content || run.content.length > 8000) throw new Error('草稿太长，请缩减要求后重试。');
      if ($('#agents-content').value !== initialContent && !confirm('编辑框已有改动，是否替换为 AI 草稿？')) { notice('已保留你的编辑，草稿未保存。'); return; }
      $('#agents-content').value = run.content; notice('草稿已生成，请检查后点击“保存人物设定”。'); return;
    }
    if (!['queued','running'].includes(run.status)) throw new Error('生成失败，请稍后重试。');
  }
});
onForm('#notes-form', async data => {
  await api('/api/account/silverbullet/login', 'POST', data); $('#notes-form input[name=password]').value = '';
  notice('笔记已更新，密码与主页一致，原笔记保留。'); await loadAccount(false);
});
onForm('#password-form', async data => {
  await api('/api/account/password', 'POST', data); $('#password-form').reset(); $('#account').hidden = true; $('#login').hidden = false;
  notice('密码已修改，请重新登录。');
});
async function cancelQr() {
  const id = attempt; attempt = null; clearTimeout(timer); $('#qr').hidden = true; $('#qr-image').removeAttribute('src');
  if (id) await api('/api/account/wechat/login/' + id, 'DELETE', {});
}
$('#wechat-bind').addEventListener('click', async () => {
  $('#wechat-bind').disabled = true;
  try {
    const result = await api('/api/account/wechat/login', 'POST', {}); attempt = result.id;
    $('#qr-image').src = result.image; $('#qr-status').textContent = '等待扫码'; $('#qr').hidden = false;
    const id = attempt;
    async function poll() {
      try {
        const status = await api('/api/account/wechat/login/' + id); if (attempt !== id) return;
        $('#qr-status').textContent = { wait: '等待扫码', scaned: '请在手机上确认', scaned_but_redirect: '正在确认', confirmed: '已连接', expired: '二维码已过期', cancelled: '已取消', failed: '绑定失败' }[status.status] || status.status;
        if (['confirmed','expired','cancelled','failed'].includes(status.status)) { attempt = null; if (status.status === 'confirmed') { $('#qr').hidden = true; await loadAccount(false); } return; }
      } catch (error) { if (attempt !== id) return; $('#qr-status').textContent = error.message; }
      if (attempt === id) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
  } catch (error) { notice(error.message); } finally { $('#wechat-bind').disabled = false; }
});
$('#qr-cancel').addEventListener('click', () => { cancelQr().catch(error => notice(error.message)); });
$('#wechat-disconnect').addEventListener('click', async () => {
  if (!confirm('解除微信连接？原数据会保留，重新连接须使用同一个微信。')) return;
  try { await api('/api/account/wechat', 'DELETE', {}); await loadAccount(false); } catch (error) { notice(error.message); }
});
$('#logout').addEventListener('click', async () => {
  try { await cancelQr(); await api('/api/logout', 'POST', {}); location.href = new URL('account', document.baseURI); } catch (error) { notice(error.message); }
});
if (inviteToken) {
  api('/api/invitation', 'POST', { invite: inviteToken }).then(data => {
    $('#register').hidden = false;
    if (data.username) { $('#register-title').textContent = '激活已有账号'; $('#register-form input[name=username]').value = data.username; $('#register-form input[name=username]').readOnly = true; }
  }).catch(error => notice(error.message));
} else { loadAccount().catch(() => {}); }
