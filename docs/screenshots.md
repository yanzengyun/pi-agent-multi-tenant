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

## 重新生成

需要已安装项目依赖、Playwright 和可执行的 Chromium。截图模块通过环境变量指定，不写入项目的生产依赖：

```sh
PI_BROWSER_MODULE=/absolute/path/to/playwright-core/index.mjs \
PI_BROWSER_BINARY=/absolute/path/to/chromium \
PI_SCREENSHOT_DIR=./docs/images \
node scripts/capture-readme.mjs
```

脚本启动临时回环服务，截图完成后关闭浏览器、后端并移除临时数据库。不要把生产凭据或生产数据传入截图脚本。

截图为浏览器直接输出的 PNG，点击 README 中的图片可打开原图。若页面发生变更，重新生成并检查截图与文档是否一致。
