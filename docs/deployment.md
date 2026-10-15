# 部署与运维

本文使用 `chat.example.com` 和 `/srv/pi-agent` 作为示例，替换为自己的域名与项目目录。项目运行一个 Node.js 后端；SilverBullet 和命令执行器按需要启用。

## 1. 准备后端

需要 Node.js ≥ 22.19；笔记服务需要 Docker，正文检索需要后端 PATH 中可执行的 `rg`（Ubuntu 包名 `ripgrep`）。公网入口建议使用 Nginx 与 HTTPS。模型任务当前全局串行运行，从少量受邀用户开始。列表/检索不需要浏览器或向量库，详见[笔记工具](note-search.md)。

```sh
git clone https://github.com/yanzengyun/pi-agent-multi-tenant.git
cd pi-agent-multi-tenant
npm ci --omit=peer --ignore-scripts --no-audit --no-fund
npm run setup:pi
cp .env.example .env
chmod 600 .env
```

编辑自己的 `.env`：

```dotenv
ASSISTANT_HOST=127.0.0.1
ASSISTANT_PORT=32214
ASSISTANT_BASE_PATH=/assistant
ASSISTANT_ORIGIN=https://chat.example.com
ASSISTANT_SECURE_COOKIES=on
ASSISTANT_DATA_DIR=./.data
ASSISTANT_ADMIN_PASSWORD=replace-with-your-own-long-password
ASSISTANT_ENGINE=pi
ASSISTANT_MODELS_FILE=./models.json
MINIMAX_CN_API_KEY=your-private-api-key
ASSISTANT_WECHAT=on
ASSISTANT_SEARCH=on
ASSISTANT_TTS=on
```

管理员初始账号为 `admin`；密码至少 12 位，仅用于首次初始化。后端默认使用锁定的 `sdk-runtime`，无需安装另一套常驻 Pi。`ASSISTANT_SEARCH` 和 `ASSISTANT_TTS` 可设为 `off`；如仅体验页面，设置 `ASSISTANT_ENGINE=mock`、关闭微信并暂不配置笔记。

需要用 DeepSeek 临时兜底时，将 `ASSISTANT_PROVIDER=deepseek`、`ASSISTANT_MODEL=deepseek-flash`，并在私有环境文件中设置 `DEEPSEEK_API_KEY`，再重启后端。聊天凭据按所选 provider 使用；MiniMax 搜索和 TTS 仍使用 `MINIMAX_CN_API_KEY`。这是显式切换当前服务模型，不是自动故障转移；恢复 MiniMax 时改回原配置。主账号的原生 Pi 会话需单独切换模型。

启动：

```sh
node --env-file=.env src/main.mjs
```

回环健康检查路径为 `http://127.0.0.1:32214/assistant/health`。生产服务保持回环监听，浏览器通过 HTTPS 反向代理访问。

## 2. 配置笔记服务

每个用户与自己的助手共用一个私有 SilverBullet Space。无需为每位用户启动一个 SilverBullet 容器。

下面以已验证版本 `2.12.0-slim` 为例，准备数据目录并启动：

```sh
mkdir -p silverbullet-data
sudo chown 10001:10001 silverbullet-data
docker run -d --name pi-silverbullet --restart unless-stopped \
  -e PUID=10001 -e PGID=10001 -e SB_RUNTIME_API=0 \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/silverbullet-data:/data" \
  ghcr.io/silverbulletmd/silverbullet:2.12.0-slim
```

先完成下面的 HTTPS 入口配置，再访问 `https://chat.example.com/.setup/` 初始化 SilverBullet：

- 将 Primary URL 设置为 `https://chat.example.com`，与助手公网 Origin 一致。
- 设置一个独立的 SilverBullet 管理员账号和长密码。
- 初始化空间只授予管理员访问；用户的私人空间由助手后端创建。

笔记服务尚未初始化时，不配置 `ASSISTANT_SB_CONFIG`；初始化完成后再启用连接。首次向导完成前，限制入口仅供部署者访问。

在项目目录创建私有 `silverbullet.json`，填写自己的配置：

```json
{
  "baseUrl": "http://127.0.0.1:3000",
  "publicUrl": "https://chat.example.com",
  "username": "your-silverbullet-admin",
  "password": "your-private-silverbullet-password"
}
```

保护文件权限并在 `.env` 中设置绝对路径：

```sh
chmod 600 silverbullet.json
```

```dotenv
ASSISTANT_SB_CONFIG=/srv/pi-agent/silverbullet.json
```

重启后端后，新用户注册会创建独立的人类/Agent 账号、Space 和受限 token，并同步主页与笔记密码。已有未准备的用户可由管理员点击“准备笔记空间”，再由用户在个人页面验证密码完成同步。Agent token 只留在服务端。

私有 `silverbullet.json` 不要提交 Git；仓库只保存代码和示例。初始化、修改用户名、修改密码等操作必须保留原账号与 Space 的映射。

## 3. 配置 HTTPS 与页面入口

下面是已配置 HTTPS 的 Nginx `server` 中的反向代理位置。证书、域名和部署目录由自己的服务器配置提供。

```nginx
location = /assistant {
    return 302 /assistant/;
}

location /assistant/ {
    proxy_pass http://127.0.0.1:32214;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
}

# 根路径及 /users/、/.auth/central/、/.setup/、/.dashboard/
# 交给 SilverBullet 自己的原生认证与 Space 权限。
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
}
```

如果父级启用了 HTTP Basic Auth，助手页面及 SilverBullet 原生认证路由需要关闭继承的 Basic Auth，避免重复出现浏览器验证弹窗。应用登录和笔记登录仍各自执行身份验证。

| 页面 | 示例入口 |
| --- | --- |
| 管理台 | `https://chat.example.com/assistant/` |
| 个人主页 | `https://chat.example.com/assistant/account` |
| 邀请注册 | 后台生成的 `/assistant/join#invite=...`，7 天有效、一次性 |
| 用户笔记 | 后台按账号生成的 `/users/<uuid>/` |

SilverBullet 的 Primary URL 必须使用公网 Origin；内部连接的 `baseUrl` 保持回环地址。反向代理需传递原始 Host 与 HTTPS 协议，不能把内部地址作为用户登录跳转入口。

## 4. 邀请与连接微信

1. 登录管理台，生成“新用户注册”邀请并分享。
2. 用户注册并自动进入个人页面，点击“扫码连接微信”。
3. 用户用自己的微信扫码确认，然后在微信发一条消息。
4. 发送“帮我记一篇笔记并保存”，再从个人页面打开笔记检查结果。

微信接口、账号状态和客户端兼容性会影响连接；过期或异常时可能需要重新扫码。提醒投递依赖可用的微信连接与消息上下文。已有账号的激活邀请仅交给账号本人；解绑不会让其他微信账号继承原用户的数据。

## 5. 常驻服务

可使用 systemd 运行后端。先创建专用的低权限运行账号，并把项目及私有数据目录授予该账号。以下示例中的 `pi-assistant`、路径与 Node 绝对路径均需按实际环境替换：

```ini
[Unit]
Description=Pi Assistant multi-tenant backend
After=network-online.target
Wants=network-online.target

[Service]
User=pi-assistant
Group=pi-assistant
WorkingDirectory=/srv/pi-agent
ExecStart=/absolute/path/to/node --env-file=/srv/pi-agent/.env /srv/pi-agent/src/main.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=180
UMask=0077

[Install]
WantedBy=multi-user.target
```

保存为 `/etc/systemd/system/pi-assistant.service` 后：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-assistant
sudo systemctl status pi-assistant
sudo journalctl -u pi-assistant --no-pager -n 30
```

使用 `command -v node` 获取 Node 的绝对路径。数据目录与私有配置不得授予其他普通用户读取权限。

## 6. 可选命令沙箱

命令执行器使用 Bubblewrap、Linux namespace、seccomp 和 cgroup；通过 Unix socket 接受后端请求，不向公网开放端口。

- 后端与执行器使用不同 Linux 身份，后端仅获得 socket 客户端组权限。
- 用户第一次调用 `cmd` 时绑定独立持久工作区，沙箱中路径为 `/work`。
- 默认池有 8 个磁盘槽位，各约 100MiB 可用；绑定用户后保留，删除用户才清空并释放。
- 每条命令创建新隔离环境，最多 30 秒、192MiB 内存、64 个进程，直接联网关闭。

执行器安装还需准备独立文件系统、cgroup delegation 和系统策略。现有 `scripts/deploy-sandbox.py`、`scripts/enable-sandbox.py` 是既有环境的安装记录，使用前逐项调整目标地址、用户和路径，不直接作为通用安装器执行。参见 [沙箱设计](sandbox-research.md) 与 `sandbox/runner.py`。

执行器验收后，才在后端环境中设置：

```dotenv
ASSISTANT_SANDBOX_SOCKET=/run/pi-sandbox/runner.sock
```

## 7. 数据、备份与迁移

后端数据结构：

```text
.data/
  assistant.sqlite            账号、记忆、聊天、队列、提醒、trace及私有集成凭据
  tenants/<uuid>/
    workspace/AGENTS.md        自定义人物设定镜像
    sessions/                 用户自己的 Pi SDK JSONL 会话
    agent/                    用户自己的 SDK 运行状态
  deleted-users/              删除后的私有归档索引
```

数据库中的配置是人物设定的来源；无自定义或留空时使用 `src/persona.mjs` 的默认设定。直接改镜像文件不会改变模型配置。

备份前等待任务结束并正常停止相关服务，完整保存：

1. `.env`、私有 SilverBullet 配置和模型配置。
2. 整个 `ASSISTANT_DATA_DIR`，包括 SQLite 及可能存在的 WAL/SHM、租户目录。
3. SilverBullet 的完整持久数据，包含用户、Space、权限与笔记文件。
4. 若启用沙箱，保存 UUID 与槽位映射以及各工作目录；不要跟随符号链接，也不要把运行中的磁盘镜像复制当作一致性备份。

迁移时保留用户 UUID、Space、token 与目录映射。SDK 会话路径可能是绝对路径；优先保留原数据路径，变更时同步调整和验证。恢复后逐项验收登录、微信、笔记、记忆、人物设定、工作区文件和提醒；不要只凭健康接口成功就认定完整恢复。

删除用户会停用账号、撤销登录、停止微信/提醒、清理聊天与工作目录；旧笔记保留为无访问成员的私有归档，历史备份保留。新注册的同名用户获得新 UUID，不继承旧数据。

单篇 Markdown 的 `note_archive` / `note_restore` / `note_delete` 与删除用户是两套流程。普通删除默认归档到本人的 `归档/YYYY-MM/<uuid>/原路径.md`，不跨 Space、不覆盖已有页面；永久删除需要明确要求、confirm=true 和已读 ETag。归档最多支持240字符原路径、30,000字符正文，附件暂不支持；删除当前文件不代表销毁历史备份。各用户操作审计保存在 `tenants/<user-id>/notes/audit.jsonl`，不记录正文或 token，随数据目录备份迁移。

复制和删除之间不是一个原子事务。系统先复制并回读，再条件删除原页；中途冲突/失败时保留副本，错误包含 `preserved_copy` 以便核对。不会为了“回滚”而覆盖或删除用户的新修改。

## 8. 更新与验证

更新前备份，等待队列空闲，停止后端并安装锁定依赖，再运行对应检查：

```sh
npm ci --omit=peer --ignore-scripts --no-audit --no-fund
npm run setup:pi
npm test
python3 -m unittest discover -s sandbox -p 'test_*.py'
```

浏览器验收应等待笔记 `.cm-editor` 实际加载，仅 URL 跳转或文件接口 HTTP200 不足以确认编辑器启动。若笔记出现 `Insufficient access to this space`，检查是否在同一浏览器中登录了另一位笔记用户；无痕窗口可用于核对身份，不应通过放宽 Space 权限解决。

现有线上验证脚本有环境绑定，真实模型/微信测试还涉及费用和账号连接；按自己的测试环境调整，使用独立测试账号。生产日志、trace、数据库、有效邀请和凭据均不进入 Git。
