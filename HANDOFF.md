# 开发交接

更新时间：2026-10-13。

## 用户目标与授权

- 将个人助手拓展为多用户服务，优先一个Pi SDK后端，共用基础服务，用户聊天/记忆/任务/凭据/trace隔离。
- 只做管理员页面；未来管理员创建用户、展示对应微信二维码，用户扫码后在微信使用。笔记仍有SB原生页面。
- 用户已要求开始开发，并指定GitHub仓库 https://github.com/yanzengyun/pi-agent-multi-tenant.git 上传代码。
- 当前个人助手必须保持可用。没有授权把真实用户状态迁入开发环境；测试仅用虚构用户。

## 当前工作：服务器重启期间继续本地开发（2026-10-13）

- 用户报告个人微信消息无回复，随后确认服务器突然出问题并正在重启；要求继续本地开发，允许当前暂不做服务器验收。不连接、部署或重载服务器；恢复后先验证个人助手。
- 本轮微信/SB二阶段代码仍在本地未提交；两个部署脚本的首次SSH均失败于认证前，没有成功执行二阶段远程部署或重载生产。
- 目前SSH连接在banner exchange超时；带鉴权的生产trace API及SilverBullet443请求均读取超时。微信公开接口从本机返回HTTP404，说明该接口主机可达，不能由此推断服务器到微信的网络情况。
- 尚未获取服务器当前进程、内存、OOM日志或微信状态，原因未确定，不能声称已恢复。不要继续部署或盲目重启生产。
- 本地二阶段已有独立微信绑定/身份保留、防串用户、SB非管理员Space/Agent token、管理员扫码UI及锁定SDK依赖。真实隔离SB与Pi工具验证已通过；真实扫码绑定与服务器验收未完成。
- 身份保护测试已通过；新增关闭期间迟到二维码/扫码回包测试，防止服务关闭后访问已关闭数据库或建立绑定。二维码及状态请求接入关闭abort信号。
- README已更新二阶段功能、配置、账号/Space映射、备份恢复和待验收限制；部署脚本改用独立锁定SDK，并修正SB启动Space的revisions枚举。脚本仅做本地静态检查，未远程执行。
- 最终本地21项自动测试全通过；Python部署/验证脚本AST检查、前端JS语法和git diff --check通过。npm run setup:pi已从独立锁文件安装121依赖，SDK导入及8个配套包全部1.1.0检查通过。无需服务器即可重现这些检查。

## 第一阶段服务器基线（重启前，不代表当前运行状态）

- Node原生HTTP与SQLite、管理员登录/建用户页面、按用户限定的记忆/聊天/运行/trace API。
- SQLite持久化队列、全局并发1、任务超时abort、重启恢复；SDK每轮创建独立AgentSession，结束dispose，JSONL按用户UUID保存。
- 原版Pi SDK1.1.0真实模型模式已验证；显式模型、auth、resourceLoader，不发现生产资料；仅memory_read/write和可选官方web_search。
- 真实开发环境测试：两个虚构用户记忆工具及注入、跨用户trace拒绝、SDK历史恢复、官方网页搜索、个人助手配置/进程不变。报告test/live-verification.json。
- 服务器开发实例源码/home/admin/pi-agent-multi-tenant-dev、状态/home/admin/.local/share/pi-agent-multi-tenant-dev、tmux pi-multi-tenant-dev，回环端口32214；没有新增公网路由。
- 管理员登录文件/home/admin/.config/pi-agent-multi-tenant-dev/login.json私有0600；不读出或打印密码。此后端复用私有环境中的模型密钥，不把密钥写Git。
- 现有个人助手admin/pi-wechat、现有SB、Nginx、任务、记忆均未修改；不可为开发重载或升级这些设施。

## 待做

1. 二阶段微信适配及管理台已经实现，真实扫码、消息收发和异常网络验收待做；不要用个人生产微信扫码开发二维码。
2. SB自动配置及真实本地隔离验证已完成，服务器部署验收待做。
3. 常驻调度与按用户消息投递；不依赖AgentSession常驻。
4. 受限健康/投资工具、聊天检索、trace管理页面、用户禁用和限额、备份恢复。
5. 通用脚本只在独立沙箱执行。公网发布前补HTTPS、安全Cookie、Origin和容量测试。

## Git与测试

- 工作区Git凭据只引用/home/q/vibe/projects/zengyuny/.git-credentials-zengyuny，不能读取/打印内容。
- 环境Git HTTPS需用/opt/vibe/ca/mitmproxy-ca-cert.pem的已配置代理CA，不能禁用TLS校验。
- 原GitHub main只有初始README，已基于origin/main开发，保留历史，禁止强推。
- npm test需Node>=22.19并先npm ci --omit=peer --ignore-scripts；本地沙箱禁止监听端口时需对回环测试请求outside-sandbox执行。
- scripts/deploy-dev.py只重启pi-multi-tenant-dev，不碰pi-wechat；重新部署前确认没有开发运行中的任务。

## Git 上传当前状态

- 用户更新token权限后重试成功，GitHub main已收到第一版开发代码；初始提交dbda1b2及后续本地提交历史保留，没有强推。
- GitHub仓库：https://github.com/yanzengyun/pi-agent-multi-tenant.git 。此前完整服务器Git副本/home/admin/pi-agent-multi-tenant，开发运行副本/home/admin/pi-agent-multi-tenant-dev；本轮二阶段不向服务器同步。
- 上传认证通过限定github.com及此仓库路径的Git credential helper读取用户授权私有文件；只引用文件，不输出token，不将凭据加入Git。临时helper在/tmp/pi-github-credential-helper.py；环境重建后若丢失，需重建同等限定的helper。
- 历史认证问题已解决：环境代理CA、失效IDE askpass、token最初缺少仓库写权限。后续不要禁用TLS校验；调用Git时移除GIT_CURL_VERBOSE等调试环境变量。
- 第一阶段本地Node24与服务器Node22环境的7项集成测试均通过；独立真实Pi SDK验证通过。二阶段增加微信及SB自动配置，但真实微信和服务器新版仍未验收。
