const $ = selector => document.querySelector(selector);
async function api(path, method = 'GET', value) {
  const response = await fetch(new URL('.' + path, document.baseURI), { method, credentials: 'same-origin',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) {
    if (result.error === 'authentication_required') { $('#console').hidden = true; $('#login').hidden = false; }
    const messages = { invalid_credentials: '账号或密码不正确。', username_exists: '账号已存在。', login_throttled: '请求较多，请稍后再试。',
      user_has_active_run: '该用户正在执行任务，请结束后再删除。', user_busy: '该用户正在更新设置或清理，请稍后重试。',
      delete_confirmation_mismatch: '输入的用户名不一致，请检查。', cannot_delete_admin: '不能删除管理员账号。',
      user_cleanup_failed: '账号已停用，但资源清理未完成。请稍后点击“重试清理”，旧数据不会转给新用户。',
      user_deletion_pending: '该账号已停用，正在等待资源清理。' };
    const error = new Error(messages[result.error] || result.error || '请求失败'); error.code = result.error; throw error;
  }
  return result;
}
function notice(message) { $('#notice').textContent = message; }
const states = { disabled: '未启用', not_bound: '未绑定', connected: '已连接', expired: '登录已过期',
  ready: '已准备', not_provisioned: '未准备', provisioning: '准备中', failed: '准备失败' };
let activeQr = null, qrTimer;
function action(label, handler) {
  const button = document.createElement('button'); button.textContent = label; button.className = 'secondary';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { notice(error.message); } finally { button.disabled = false; }
  }); return button;
}
async function bindWechat(user) {
  const result = await api(`/api/admin/users/${user.id}/wechat/login`, 'POST', {});
  activeQr = { userId: user.id, id: result.id }; $('#qr-title').textContent = `绑定微信 · ${user.username}`;
  $('#qr-image').src = result.image; $('#qr-status').textContent = '等待扫码'; $('#wechat-dialog').showModal();
  const current = activeQr;
  async function poll() {
    try {
      const status = await api(`/api/admin/users/${current.userId}/wechat/login/${current.id}`);
      if (activeQr !== current) return;
      $('#qr-status').textContent = { wait: '等待扫码', scaned: '已扫码，请在手机上确认', scaned_but_redirect: '正在切换登录服务',
        confirmed: '微信已绑定，笔记空间会自动准备', expired: '二维码已过期，请关闭后重新生成', cancelled: '已取消', failed: '绑定失败' }[status.status] || status.status;
      if (['confirmed', 'expired', 'cancelled', 'failed'].includes(status.status)) {
        activeQr = null; await showConsole(); return;
      }
    } catch (error) { if (activeQr !== current) return; $('#qr-status').textContent = error.message; }
    if (activeQr === current) qrTimer = setTimeout(poll, 2000);
  }
  qrTimer = setTimeout(poll, 2000);
}
async function closeQr() {
  const current = activeQr; activeQr = null; clearTimeout(qrTimer); $('#wechat-dialog').close(); $('#qr-image').removeAttribute('src');
  if (current) await api(`/api/admin/users/${current.userId}/wechat/login/${current.id}`, 'DELETE', {});
}
$('#qr-close').addEventListener('click', () => { closeQr().catch(error => notice(error.message)); });
$('#wechat-dialog').addEventListener('cancel', event => { event.preventDefault(); closeQr().catch(error => notice(error.message)); });
$('#sb-close').addEventListener('click', () => { $('#sb-dialog').close(); $('#sb-password').value = ''; });
$('#sb-dialog').addEventListener('cancel', () => { $('#sb-password').value = ''; });
$('#sb-reveal').addEventListener('click', () => { $('#sb-password').type = $('#sb-password').type === 'password' ? 'text' : 'password'; });
let traceView = null;
function clearTrace() {
  traceView = null; $('#trace-runs').replaceChildren(); $('#trace-events').replaceChildren();
}
$('#trace-close').addEventListener('click', () => { $('#trace-dialog').close(); clearTrace(); });
$('#trace-dialog').addEventListener('cancel', clearTrace);
async function showTrace(user) {
  const view = {}; traceView = view;
  $('#trace-title').textContent = `运行记录 · ${user.username}`;
  $('#trace-runs').textContent = '正在加载'; $('#trace-events').replaceChildren(); $('#trace-dialog').showModal();
  try {
    const result = await api(`/api/admin/users/${user.id}/runs`);
    if (traceView !== view) return;
    $('#trace-runs').replaceChildren();
    if (!result.runs.length) $('#trace-runs').textContent = '还没有运行记录';
    for (const run of result.runs) {
      $('#trace-runs').append(action(`${new Date(run.created_at).toLocaleString()} · ${run.status} · ${run.preview}`, async () => {
        const selection = {}; view.selection = selection;
        const detail = await api(`/api/admin/users/${user.id}/runs/${run.id}/trace`);
        if (traceView !== view || view.selection !== selection) return;
        $('#trace-events').replaceChildren();
        const summary = document.createElement('pre');
        summary.textContent = JSON.stringify({ input: detail.run.prompt, status: detail.run.status,
          response: detail.run.response, error: detail.run.error }, null, 2);
        $('#trace-events').append(summary);
        for (const event of detail.events) {
          const item = document.createElement('details'), title = document.createElement('summary'), content = document.createElement('pre');
          title.textContent = `${new Date(event.created_at).toLocaleTimeString()} · ${event.kind}`;
          content.textContent = JSON.stringify(event.payload, null, 2); item.append(title, content); $('#trace-events').append(item);
        }
      }));
    }
  } catch (error) { if (traceView === view) $('#trace-runs').textContent = error.message; }
}
async function showConsole() {
  const me = await api('/api/me');
  if (me.role !== 'admin') { location.replace(new URL('account', document.baseURI)); return; }
  const data = await api('/api/admin/users');
  const select = $('#invite-target'), prior = select.value; select.replaceChildren();
  const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = '新用户注册'; select.append(fresh);
  for (const user of data.users.filter(user => user.role === 'user' && !user.deletion_status)) {
    const option = document.createElement('option'); option.value = user.id; option.textContent = `激活已有账号：${user.username}`; select.append(option);
  }
  select.value = prior; await refreshInvites();
  $('#login').hidden = true; $('#console').hidden = false;
  $('#mode').textContent = data.mode === 'mock' ? '测试模式：不调用真实模型' : 'Pi SDK：真实模型模式';
  const members = data.users.filter(user => user.role === 'user');
  $('#user-summary').textContent = `${members.length} 位用户 · ${members.filter(user => user.wechat.status === 'connected').length} 位已连接微信`;
  $('#users').replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('article');
    row.dataset.username = user.username.toLowerCase();
    const name = document.createElement('strong'); name.textContent = user.username;
    const detail = document.createElement('span'); detail.textContent = user.role === 'admin' ? '管理员' :
      user.deletion_status ? '已停用 · 等待资源清理，可重试' : `微信：${states[user.wechat.status] || user.wechat.status} · 笔记：${states[user.silverbullet.status] || user.silverbullet.status}`;
    const info = document.createElement('div'); info.append(name, detail); row.append(info);
    if (user.role !== 'admin') {
      const controls = document.createElement('div'); controls.className = 'actions';
      const remove = action(user.deletion_status ? '重试清理' : '删除用户', () => showDeletion(user)); remove.className = 'danger';
      if (user.deletion_status) { controls.append(remove); row.append(controls); $('#users').append(row); continue; }
      controls.append(action('账号激活 / 重置密码', async () => { $('#invite-target').value = user.id; $('#invite-form').requestSubmit(); $('#invite-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
      controls.append(action('运行记录', () => showTrace(user)));
      controls.append(action('定时提醒', () => showReminders(user)));
      if (data.wechatEnabled) controls.append(user.wechat.status === 'not_bound'
        ? action('微信扫码', () => bindWechat(user))
        : action('解除绑定', async () => { if (confirm(`解除 ${user.username} 的微信连接？身份归属保留，重新扫码须使用原微信。`)) { await api(`/api/admin/users/${user.id}/wechat`, 'DELETE', {}); await showConsole(); } }));
      if (data.silverbulletEnabled) controls.append(user.silverbullet.status === 'ready'
        ? action('笔记登录信息', async () => {
          const login = await api(`/api/admin/users/${user.id}/silverbullet/credentials`, 'POST', {});
          $('#sb-url').value = login.url; $('#sb-username').value = login.username; $('#sb-password').value = login.password || '';
          $('#sb-password-state').textContent = login.passwordManagedByUser ? '用户已自行设置密码，后台不显示。' : '';
          $('#sb-password').type = 'password'; $('#sb-dialog').showModal();
        })
        : action('准备笔记空间', async () => { await api(`/api/admin/users/${user.id}/silverbullet`, 'POST', {}); await showConsole(); }));
      controls.append(remove); row.append(controls);
    }
    $('#users').append(row);
  }
  filterUsers();
}
let deletionUser = null, deleting = false;
function showDeletion(user) {
  deletionUser = user; $('#delete-title').textContent = `${user.deletion_status ? '重试清理' : '删除用户'} · ${user.username}`;
  $('#delete-form').reset(); $('#delete-form input').placeholder = user.username; $('#delete-status').textContent = '';
  $('#delete-dialog').showModal();
}
$('#delete-close').addEventListener('click', () => { if (!deleting) { $('#delete-dialog').close(); deletionUser = null; } });
$('#delete-dialog').addEventListener('cancel', event => { if (deleting) event.preventDefault(); else deletionUser = null; });
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!deletionUser || deleting) return;
  const user = deletionUser, confirmUsername = new FormData(event.target).get('confirmUsername');
  if (confirmUsername !== user.username) { $('#delete-status').textContent = '输入的用户名不一致，请检查。'; return; }
  deleting = true; const button = event.target.querySelector('button'); button.disabled = true; $('#delete-close').disabled = true;
  $('#delete-status').textContent = '正在停用账号并清理资源，请稍候…';
  try {
    const result = await api('/api/admin/users/' + user.id, 'DELETE', { confirmUsername });
    $('#delete-dialog').close(); deletionUser = null;
    notice(result.notesArchived ? '用户已删除，旧笔记已归档且原账号不可访问。' : '用户已删除，历史备份保留。'); await showConsole();
  } catch (error) {
    $('#delete-status').textContent = error.message;
    await showConsole().catch(() => {});
  } finally { deleting = false; button.disabled = false; $('#delete-close').disabled = false; }
});
function filterUsers() {
  const query = $('#user-search').value.trim().toLowerCase(); let visible = 0;
  for (const row of $('#users').children) { row.hidden = !row.dataset.username.includes(query); if (!row.hidden) visible++; }
  $('#user-empty').hidden = visible !== 0;
}
$('#user-search').addEventListener('input', filterUsers);
$('#refresh-users').addEventListener('click', async event => {
  event.target.disabled = true;
  try { await showConsole(); notice('状态已刷新。'); } catch (error) { notice(error.message); } finally { event.target.disabled = false; }
});
let reminderUser = null;
async function refreshReminders() {
  const user = reminderUser, data = await api(`/api/admin/users/${user.id}/reminders`);
  if (reminderUser !== user) return;
  $('#reminder-list').replaceChildren();
  if (!data.reminders.length) $('#reminder-list').textContent = '暂无提醒';
  for (const task of data.reminders) {
    const row = document.createElement('article'), label = document.createElement('span');
    const state = { scheduled: '等待执行', waiting_for_wechat: '等待微信连接及首条消息', completed: '已排入投递', expired: '已过期，不补发' }[task.status] || task.status;
    label.textContent = `${new Date(task.next_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${task.weekdays_only ? '周一至周五' : task.repeat_daily ? '每天' : '一次'} · ${state} · ${task.text}`;
    row.append(label, action('取消', async () => {
      await api(`/api/admin/users/${user.id}/reminders/${task.id}`, 'DELETE', {}); await refreshReminders();
    })); $('#reminder-list').append(row);
  }
}
async function showReminders(user) {
  reminderUser = user; $('#reminder-title').textContent = `定时提醒 · ${user.username}`;
  $('#reminder-status').textContent = ''; $('#reminder-list').replaceChildren(); $('#reminder-form').reset();
  $('#reminder-dialog').showModal(); await refreshReminders();
}
$('#reminder-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!reminderUser) return;
  const data = new FormData(event.target);
  try {
    await api(`/api/admin/users/${reminderUser.id}/reminders`, 'POST', {
      text: data.get('text'), at: data.get('at') + ':00+08:00', daily: data.has('daily'),
    });
    event.target.reset(); $('#reminder-status').textContent = '提醒已保存'; await refreshReminders();
  } catch (error) { $('#reminder-status').textContent = error.message; }
});
$('#reminder-close').addEventListener('click', () => { $('#reminder-dialog').close(); reminderUser = null; });
$('#reminder-dialog').addEventListener('cancel', () => { reminderUser = null; });
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.target);
  const button = event.target.querySelector('button'); button.disabled = true;
  try { await api('/api/login', 'POST', Object.fromEntries(form)); $('#login-form').reset(); await showConsole(); notice(''); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$('#user-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { const user = await api('/api/admin/users', 'POST', Object.fromEntries(new FormData(event.target))); event.target.reset(); await showConsole(); $('#invite-target').value = user.id; notice('用户已创建。请生成账号激活邀请，让本人设置密码并登录。'); }
  catch (error) { notice(error.message); }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST', {}); location.reload(); } catch (error) { notice(error.message); }
});
async function refreshInvites() {
  const data = await api('/api/admin/invites'); $('#invite-list').replaceChildren();
  for (const invite of data.invitations) {
    const row = document.createElement('article'), label = document.createElement('span');
    const expired = invite.expires_at <= Date.now(), inactive = invite.used_at || invite.revoked || expired;
    label.textContent = `${invite.target_username || '新用户'} · ${invite.used_at ? '已使用' : invite.revoked ? '已撤销' : expired ? '已过期' : '待使用'} · ${new Date(invite.expires_at).toLocaleString()}`;
    row.append(label);
    if (!inactive) row.append(action('撤销邀请', async () => { await api('/api/admin/invites/' + invite.id, 'DELETE', {}); await refreshInvites(); }));
    $('#invite-list').append(row);
  }
}
$('#invite-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/api/admin/invites', 'POST', { userId: $('#invite-target').value || undefined });
    $('#invite-url').value = result.url; $('#invite-result').hidden = false; $('#invite-copy').textContent = '复制邀请链接'; await refreshInvites(); notice('邀请已生成，请复制链接交给对应用户。');
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$('#invite-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#invite-url').value); $('#invite-copy').textContent = '已复制'; }
  catch { $('#invite-url').focus(); $('#invite-url').select(); notice('请复制已选中的邀请链接。'); }
});
showConsole().catch(error => { if (error.code !== 'authentication_required') notice(error.message); });
