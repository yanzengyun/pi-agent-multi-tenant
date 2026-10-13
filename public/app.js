const $ = selector => document.querySelector(selector);
async function api(path, method = 'GET', value) {
  const response = await fetch(new URL('.' + path, document.baseURI), { method, credentials: 'same-origin',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
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
  if (me.role !== 'admin') throw new Error('只有管理员可以使用此管理台');
  const data = await api('/api/admin/users');
  $('#login').hidden = true; $('#console').hidden = false;
  $('#mode').textContent = data.mode === 'mock' ? '测试模式：不调用真实模型' : 'Pi SDK：真实模型模式';
  $('#users').replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('article');
    const name = document.createElement('strong'); name.textContent = user.username;
    const detail = document.createElement('span'); detail.textContent = user.role === 'admin' ? '管理员' :
      `微信：${states[user.wechat.status] || user.wechat.status} · 笔记：${states[user.silverbullet.status] || user.silverbullet.status}`;
    const info = document.createElement('div'); info.append(name, detail); row.append(info);
    if (user.role !== 'admin') {
      const controls = document.createElement('div'); controls.className = 'actions';
      controls.append(action('运行记录', () => showTrace(user)));
      controls.append(action('定时提醒', () => showReminders(user)));
      if (data.wechatEnabled) controls.append(user.wechat.status === 'not_bound'
        ? action('微信扫码', () => bindWechat(user))
        : action('解除绑定', async () => { if (confirm(`解除 ${user.username} 的微信连接？身份归属保留，重新扫码须使用原微信。`)) { await api(`/api/admin/users/${user.id}/wechat`, 'DELETE', {}); await showConsole(); } }));
      if (data.silverbulletEnabled) controls.append(user.silverbullet.status === 'ready'
        ? action('笔记登录信息', async () => {
          const login = await api(`/api/admin/users/${user.id}/silverbullet/credentials`, 'POST', {});
          $('#sb-url').value = login.url; $('#sb-username').value = login.username; $('#sb-password').value = login.password;
          $('#sb-password').type = 'password'; $('#sb-dialog').showModal();
        })
        : action('准备笔记空间', async () => { await api(`/api/admin/users/${user.id}/silverbullet`, 'POST', {}); await showConsole(); }));
      row.append(controls);
    }
    $('#users').append(row);
  }
}
let reminderUser = null;
async function refreshReminders() {
  const user = reminderUser, data = await api(`/api/admin/users/${user.id}/reminders`);
  if (reminderUser !== user) return;
  $('#reminder-list').replaceChildren();
  if (!data.reminders.length) $('#reminder-list').textContent = '暂无提醒';
  for (const task of data.reminders) {
    const row = document.createElement('article'), label = document.createElement('span');
    const state = { scheduled: '等待执行', waiting_for_wechat: '等待微信连接及首条消息', completed: '已排入投递' }[task.status] || task.status;
    label.textContent = `${new Date(task.next_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${task.repeat_daily ? '每天' : '一次'} · ${state} · ${task.text}`;
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
