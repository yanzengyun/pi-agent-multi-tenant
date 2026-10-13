# 开发交接

更新时间：2026-10-13。

## 用户目标与授权

- 将个人助手拓展为多用户服务，优先一个Pi SDK后端，共用基础服务，用户聊天/记忆/任务/凭据/trace隔离。
- 只做管理员页面；未来管理员创建用户、展示对应微信二维码，用户扫码后在微信使用。笔记仍有SB原生页面。
- 用户已要求开始开发，并指定GitHub仓库 https://github.com/yanzengyun/pi-agent-multi-tenant.git 上传代码。
- 当前个人助手必须保持可用。没有授权把真实用户状态迁入开发环境；测试仅用虚构用户。

## 当前实现

- Node原生HTTP与SQLite、管理员登录/建用户页面、按用户限定的记忆/聊天/运行/trace API。
- SQLite持久化队列、全局并发1、任务超时abort、重启恢复；SDK每轮创建独立AgentSession，结束dispose，JSONL按用户UUID保存。
- 原版Pi SDK1.1.0真实模型模式已验证；显式模型、auth、resourceLoader，不发现生产资料；仅memory_read/write和可选官方web_search。
- 真实开发环境测试：两个虚构用户记忆工具及注入、跨用户trace拒绝、SDK历史恢复、官方网页搜索、个人助手配置/进程不变。报告test/live-verification.json。
- 服务器开发实例源码/home/admin/pi-agent-multi-tenant-dev、状态/home/admin/.local/share/pi-agent-multi-tenant-dev、tmux pi-multi-tenant-dev，回环端口32214；没有新增公网路由。
- 管理员登录文件/home/admin/.config/pi-agent-multi-tenant-dev/login.json私有0600；不读出或打印密码。此后端复用私有环境中的模型密钥，不把密钥写Git。
- 现有个人助手admin/pi-wechat、现有SB、Nginx、任务、记忆均未修改；不可为开发重载或升级这些设施。

## 待做

1. 微信多连接适配，管理员二维码生成、绑定、过期/取消/重复扫码与真实用户投递验证。当前没有二维码，不冒充已完成。
2. SB自动配置：人类用户、非管理员Agent账号/token和Space；匿名none，跨Space/API验证。
3. 常驻调度与按用户消息投递；不依赖AgentSession常驻。
4. 受限健康/投资工具、聊天检索、trace管理页面、用户禁用和限额、备份恢复。
5. 通用脚本只在独立沙箱执行。公网发布前补HTTPS、安全Cookie、Origin和容量测试。

## Git与测试

- 工作区Git凭据只引用/home/q/vibe/projects/zengyuny/.git-credentials-zengyuny，不能读取/打印内容。
- 环境Git HTTPS需用/opt/vibe/ca/mitmproxy-ca-cert.pem的已配置代理CA，不能禁用TLS校验。
- 原GitHub main只有初始README，已基于origin/main开发，保留历史，禁止强推。
- npm test只需Node>=22.19，无需npm install；本地沙箱禁止监听端口时需对回环测试请求outside-sandbox执行。
- scripts/deploy-dev.py只重启pi-multi-tenant-dev，不碰pi-wechat；重新部署前确认没有开发运行中的任务。

## Git 上传当前状态

- 第一版已本地提交，并通过Git bundle同步服务器完整仓库/home/admin/pi-agent-multi-tenant；开发运行副本另在/home/admin/pi-agent-multi-tenant-dev。
- GitHub仓库可公开读取，main初始提交dbda1b2保留。首次push失败：IDE askpass socket失效；排除IDE后仍无GitHub用户名凭据，现有项目credential store未返回GitHub认证。没有强推，也没有关闭TLS校验。
- 已向用户询问配置GitHub写入认证方式：只授权指定仓库Contents读写的私有token文件，或网页登录授权。等待用户提供认证；拿到后继续push与远端提交核验，不能把token写日志/回复/Git。
- 本地Node24与服务器Node22环境的7项集成测试均通过。独立真实Pi SDK测试通过；开发服务约160MiB RSS，仅回环32214。

- 用户随后提供私有token文件，已将权限收紧为0600；只通过限定仓库的Git credential helper传递，不输出token。GitHub认证识别账号yanzengyun，但push返回403 Permission denied，当前token缺少此仓库可用写权限。已请用户确认token仓库选择和Contents=Read and write，保存/必要时更新文件后重试。不能误报已上传。
