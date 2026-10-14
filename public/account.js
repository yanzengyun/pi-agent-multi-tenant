const $ = selector => document.querySelector(selector);
const errors = { invalid_invite: '邀请已失效、被使用或撤销，请联系管理员获取新链接。', invite_username_mismatch: '请使用邀请指定的账号。',
  username_exists: '账号已存在，请换一个或获取原账号的激活邀请。', invalid_username: '账号只能包含字母、数字、下划线和短横线。',
  password_too_short: '密码至少需要12位。', invalid_credentials: '账号或密码不正确。', sb_username_conflict: '笔记用户名已被占用，请换一个。',
  sb_login_update_failed: '笔记登录信息更新失败，请稍后重试。', wrong_password: '当前密码不正确。', login_throttled: '请求较多，请稍后再试。',
  authentication_required: '登录已过期，请重新登录。' };
async function api(path, method = 'GET', data) {
  const r = await fetch(new URL('.' + path, document.baseURI), { method, credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await r.json();
  if (!r.ok) {
    if (value.error === 'authentication_required') { stopQr(); view('login'); }
    const error = new Error(errors[value.error] || value.error || '请求失败'); error.code = value.error; throw error;
  }
  return value;
}
function notice(message) { $('#notice').textContent = message; }
function view(name) {
  for (const id of ['loading', 'invite-error', 'register', 'login', 'account']) $('#' + id).hidden = id !== name;
  $('#page-title').textContent = name === 'register' ? '欢迎使用 Pi 助手' : name === 'invite-error' ? '邀请注册' : '我的助手';
  $('#page-description').textContent = name === 'register' ? '设置账号 → 连接微信 → 开始聊天' : '连接微信，管理笔记和人物设定。';
  $('#admin-link').hidden = name === 'register' || name === 'invite-error' || name === 'account';
}
function panel(name) {
  for (const button of document.querySelectorAll('#account-nav button')) {
    const active = button.dataset.panel === name; button.setAttribute('aria-pressed', String(active));
    $('#panel-' + button.dataset.panel).hidden = !active;
  }
}
for (const button of document.querySelectorAll('#account-nav button')) button.addEventListener('click', () => panel(button.dataset.panel));
function confirmPassword(data) {
  if (data.password !== data.passwordConfirm) throw new Error('两次输入的密码不一致。');
  delete data.passwordConfirm;
}
function onForm(id, handler) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await handler(Object.fromEntries(new FormData(event.target))); }
    catch (error) {
      if (error.code === 'invalid_invite') { view('invite-error'); $('#invite-error-message').textContent = error.message; notice(''); }
      else notice(error.message);
    } finally { button.disabled = false; }
  });
}
const statuses = { connected: '已连接', not_bound: '未连接', expired: '登录已过期，请解除连接后重新扫码', disabled: '未启用', ready: '已准备', not_provisioned: '尚未设置', failed: '准备失败', provisioning: '准备中' };
let attempt = null, timer, inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
let savedPersona = '';
$('#agents-content').addEventListener('input', () => { $('#persona-state').textContent = $('#agents-content').value === savedPersona ? '' : '有未保存的修改'; });
window.addEventListener('beforeunload', event => {
  if (!$('#account').hidden && $('#agents-content').value !== savedPersona) { event.preventDefault(); event.returnValue = ''; }
});
async function loadAccount(refreshProfile = true) {
  const data = await api('/api/account');
  $('#account-name').textContent = data.user.username;
  $('#wechat-state').textContent = statuses[data.wechat.status] || data.wechat.status;
  $('#wechat-help').textContent = data.wechat.status === 'connected' ? '已连接，可以直接在微信与助手聊天。' : '扫码连接后，在微信发一条消息就能开始聊天。';
  $('#setup-state').textContent = data.wechat.status === 'connected' ? '微信已连接 · 在下方管理你的设置' : '下一步：扫码连接微信，开始使用助手';
  $('#wechat-bind').hidden = !['not_bound'].includes(data.wechat.status);
  $('#wechat-disconnect').hidden = !['connected','expired'].includes(data.wechat.status);
  $('#notes-state').textContent = statuses[data.silverbullet.status] || data.silverbullet.status;
  $('#notes-form input[name=username]').value = data.silverbullet.username || data.user.username;
  $('#notes-login-help').textContent = data.silverbullet.passwordUnified
    ? `笔记账号：${data.silverbullet.username || data.user.username}。默认使用主页密码，无需单独设置。`
    : '旧账号的笔记密码尚未同步。输入当前主页密码验证一次，即可共用密码。';
  $('#notes-settings-title').textContent = data.silverbullet.passwordUnified ? '修改笔记用户名' : '同步旧账号的笔记登录';
  $('#notes-save').textContent = data.silverbullet.passwordUnified ? '验证并保存用户名' : '验证并同步笔记';
  $('#notes-settings').hidden = data.silverbullet.status === 'disabled';
  if (refreshProfile) $('#notes-settings').open = data.silverbullet.status !== 'disabled' && !data.silverbullet.passwordUnified;
  $('#notes-link').hidden = !data.silverbullet.url;
  if (data.silverbullet.url) $('#notes-link').href = data.silverbullet.url;
  if (refreshProfile) { savedPersona = (await api('/api/account/agents')).content; $('#agents-content').value = savedPersona; $('#persona-state').textContent = ''; }
  view('account');
}
onForm('#register-form', async data => {
  confirmPassword(data);
  const result = await api('/api/register', 'POST', { ...data, invite: inviteToken });
  inviteToken = null; history.replaceState(null, '', new URL('account', document.baseURI));
  $('#register-form').reset(); panel('connections'); await loadAccount(); notice(result.notesPending ? '注册成功并已登录。笔记暂未同步，请展开笔记设置重试。' : '注册成功并已登录，接下来扫码连接微信即可。');
});
onForm('#login-form', async data => {
  const result = await api('/api/login', 'POST', data); $('#login-form').reset();
  if (result.user.role === 'admin') { location.replace(new URL('./', document.baseURI)); return; }
  notice(''); panel('connections'); await loadAccount();
});
onForm('#agents-form', async data => { await api('/api/account/agents', 'PUT', data); savedPersona = data.content; $('#persona-state').textContent = '已保存'; notice('人物设定已保存，后续对话生效。'); });
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
      $('#agents-content').value = run.content; $('#persona-state').textContent = 'AI 草稿尚未保存'; notice('草稿已生成，请检查后点击“保存人物设定”。'); return;
    }
    if (!['queued','running'].includes(run.status)) throw new Error('生成失败，请稍后重试。');
  }
});
onForm('#notes-form', async data => {
  await api('/api/account/silverbullet/login', 'POST', data); $('#notes-form input[name=password]').value = '';
  await loadAccount(false); $('#notes-settings').open = false; notice('笔记已更新，密码仍与主页一致，无需单独设置。');
});
onForm('#password-form', async data => {
  confirmPassword(data);
  await api('/api/account/password', 'POST', data); stopQr(); $('#password-form').reset(); view('login');
  notice('密码已修改，请重新登录。');
});
function stopQr() { attempt = null; clearTimeout(timer); $('#qr').hidden = true; $('#qr-image').removeAttribute('src'); }
async function cancelQr() {
  const id = attempt; stopQr();
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
    $('#invite-expiry').textContent = `邀请有效期至 ${new Date(data.expiresAt).toLocaleString('zh-CN')}，只能使用一次。`;
    if (data.username) {
      $('#register-title').textContent = '激活你的助手账号'; $('#register-description').textContent = '重新设置登录密码，原有聊天、微信连接和笔记会保留。';
      $('#register-submit').textContent = '设置密码并进入我的助手';
      $('#register-form input[name=username]').value = data.username; $('#register-form input[name=username]').readOnly = true;
    }
    view('register');
  }).catch(error => { view('invite-error'); $('#invite-error-message').textContent = error.message; });
} else if (location.pathname.replace(/\/$/, '').endsWith('/join')) {
  view('invite-error'); $('#invite-error-message').textContent = '链接中缺少邀请信息，请使用管理员分享的完整链接。';
} else {
  api('/api/me').then(async me => {
    if (me.role === 'admin') { location.replace(new URL('./', document.baseURI)); return; }
    await loadAccount();
  }).catch(error => { view('login'); if (error.code !== 'authentication_required') notice('页面加载失败，请刷新重试。'); });
}
