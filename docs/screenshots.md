# 页面截图

README 的截图由 `scripts/capture-readme.mjs` 打开当前应用的真实页面生成，未修改页面结构、文案或 CSS。

截图运行独立的临时后端与 SQLite，使用 `demo_alice`、`demo_bob` 演示账号。模型采用 mock；SilverBullet 连接状态是演示数据，微信二维码只编码 `https://example.org/pi-assistant-demo`，不能用于连接微信。没有访问生产后台，也没有使用真实用户、密码、邀请链接或笔记正文。

| 文件 | 页面 |
| --- | --- |
| `images/admin.png` | 管理员用户概览、邀请入口和用户操作 |
| `images/invitation.png` | 邀请注册表单 |
| `images/account.png` | 用户个人页面、微信连接与笔记入口 |
| `images/wechat-connect.png` | 手机尺寸的用户扫码页面 |
| `images/persona.png` | 默认人物设定与 AI 草稿入口 |
| `images/voice.png` | 系统音色、语速、语气与试听设置 |
| `images/notes-alice.png` | Alice 的生活与学习笔记目录，真实 SilverBullet 界面 |
| `images/notes-bob.png` | Bob 的项目与工作笔记目录，真实 SilverBullet 界面 |
| `images/notes-trip.png` | 旅行计划示例，包含表格、待办和相关笔记链接 |

笔记截图由独立的 `scripts/capture-notes-readme.mjs` 生成：本地临时启动官方 SilverBullet `2.12.0-slim`，使用应用现有 `SilverBullet` 适配器创建两个演示用户及独立 Space，通过笔记工具为每人写入24篇主题页和一篇首页。标题覆盖旅行、Python、健康、阅读、项目、工作等目录；多数页只有演示标记和占位文字，旅行页额外提供虚构行程。脚本核验跨用户读取被拒绝，再以两个独立浏览器上下文登录并截图；没有连接生产服务器、调用真实模型或发送微信。空间、数据库和临时容器在结束时移除，PNG 保留。

这些图片展示的是每位用户与本人助手共用笔记及用户之间的空间隔离。

## 重新生成

需要已安装项目依赖、Playwright 和可执行的 Chromium。截图模块通过环境变量指定，不写入项目的生产依赖：

```sh
PI_BROWSER_MODULE=/absolute/path/to/playwright-core/index.mjs \
PI_BROWSER_BINARY=/absolute/path/to/chromium \
PI_SCREENSHOT_DIR=./docs/images \
node scripts/capture-readme.mjs
```

脚本启动临时回环服务，截图完成后关闭浏览器、后端并移除临时数据库。不要把生产凭据或生产数据传入截图脚本。

笔记截图另需可用的 Docker 和官方镜像：

```sh
docker pull ghcr.io/silverbulletmd/silverbullet:2.12.0-slim
PI_BROWSER_MODULE=/absolute/path/to/playwright-core/index.mjs \
PI_BROWSER_BINARY=/absolute/path/to/chromium \
PI_SCREENSHOT_DIR=./docs/images \
node scripts/capture-notes-readme.mjs
```

SilverBullet 仅绑定回环地址，禁用 Runtime API 和 shell，容器内存上限192MiB。浏览器在本地运行；也可用 `PI_BROWSER_WS` 连接自己启动的兼容 Playwright 浏览器服务，浏览器必须能访问同一主机回环地址。截图没有改写 SilverBullet 的页面结构、样式或用户界面。

截图为浏览器直接输出的 PNG，点击 README 中的图片可打开原图。若页面发生变更，重新生成并检查截图与文档是否一致。
