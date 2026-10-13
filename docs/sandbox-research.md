# Vibe 原理与轻量沙箱调研

调研日期：2026-10-13。检查以只读方式进行，未安装沙箱、未修改服务器策略或重启生产服务。

## 当前 Vibe：观测与边界

当前执行环境的 PID 1 为 docker-init，cgroup 路径包含 /docker/<id>，可确认本会话位于 Docker 容器内。当前命令进程 CapEff=0、NoNewPrivs=1、Seccomp=2；挂载表显示根目录只读、工作区和/tmp可写，工作区的.git/.agents/.codex/.aws另有只读挂载。这些说明实际存在OS级执行限制，不能通过聊天里授权取消。

没有拿到宿主机完整部署配置，不把“当前会话在容器内”扩展为“每个Vibe用户独占Docker容器”，也不据此确认内层执行限制的完整实现。只读根目录不等于只允许读取自己的文件。

移动端源码 mobile/workspaces.py 将登录身份固定映射到项目根和该用户的Codex daemon socket，核对thread cwd归属。若socket在daemon容器挂载命名空间中，通过校验进程后使用/proc/<pid>/root访问。mobile/codex_gateway.py以thread/start或thread/resume、turn/start复用daemon和会话；移动端没有再启动一套Codex服务。

前期移动端SSH失败来自turn/start硬编码networkAccess=false；现在用户已重启服务并勾选联网，root SSH实际成功。网络权限和文件写入范围是不同维度。应用身份校验、外层容器、命令沙箱三者各有职责。

## Alibaba 主机适配条件

实测：Ubuntu Linux 6.8.0-63-generic，2CPU，1613MiB总内存，约665MiB available，无swap；Docker29.1.3，cgroup v2，AppArmor与内置seccomp。用户namespace开关为1，max_user_namespaces=6177，但apparmor_restrict_unprivileged_userns=1。/dev/kvm不存在；未检测到bwrap/nsjail/runsc/firecracker可执行文件。

因此不能把userns开关已开启解释为Bubblewrap必然可运行；必须实测AppArmor兼容性。Firecracker在此主机目前不满足KVM设备条件。内存数字是瞬时观测，不是并发容量承诺。

## 候选方案

| 方案 | 实现与代价 | 对本项目的判断 |
| --- | --- | --- |
| Bubblewrap | 按进程构造mount/user/PID/network namespace，可加载seccomp，无常驻Docker管理服务；需要自己定义挂载和资源策略 | 当前少量邀请用户的轻量原型首选，资源限制交给cgroup/systemd执行服务 |
| NsJail | namespace、seccomp、cgroup和rlimit组合，适合集中执行命令；配置及构建成本需评估 | 若资源控制和执行服务优先，可作Bubblewrap备选 |
| Anthropic sandbox-runtime | Node集成库，Linux基于Bubblewrap，提供文件规则及联网代理；不替代租户身份鉴权或资源配额 | 与现有Node后端接近，值得验证；默认广泛允许读取，必须配置自己的读取边界 |
| Docker / rootless Docker | 标准OCI环境，资源限制和镜像分发成熟；多一个管理层，但现有Docker已部署 | 安装兼容性和环境复现优先时仍合理，不应把Pi加入宿主机docker组 |
| gVisor | 在OCI环境中增加用户态内核层，额外系统调用、文件和网络开销 | 面向更多陌生用户任意代码时优先评估；性能不能套用普通容器测量 |
| Firecracker | KVM microVM，独立guest内核，需要guest kernel/rootfs及VM生命周期管理 | 当前/dev/kvm缺失，暂不采用；不能用VMM自身开销代表Python/浏览器整个实例占用 |
| OpenSandbox | 生命周期和执行API管理层，支持Docker/Kubernetes等后端 | 后期跨机器和统一沙箱API时考虑，不等于更轻的隔离内核 |
| pi-safe | 包装整套Pi的Bubblewrap脚本，系统只读、当前目录及~/.pi可写，默认全盘可读/网络不限 | 可参考工具接法，但不能原样用作本项目的租户隔离 |

不提供未经实测的毫秒启动或MB额外开销排名。轻量性判断基于是否需要常驻管理层、guest内核或用户态内核，实际消耗受命令和依赖影响。

## 建议的轻量实现

保留1个Pi SDK后端、共享SB，增加1个独立低权限sandbox-runner。用户目录持久化，每次命令按需启动进程沙箱，不需要5个常驻Pi或5个常驻容器。

后端通过认证上下文确定UUID，执行器只接受后端授予的身份；模型不能自行提供userId、挂载源、容器名或资源上限。对cmd之外的文件工具也必须执行相同边界，不能一边沙箱bash一边保留宿主机通用read/write。

最小根文件系统只挂载可信运行依赖与当前UUID的数据目录；不使用“全盘只读+自己目录可写”代替读取隔离。环境变量使用最小允许列表，清除模型密钥、后台密码和其他用户凭据。不挂载Docker/systemd/daemon socket。用户自己的AGENTS.md及笔记仍通过受限专用工具管理。

第一版离线执行；联网后通过受控出口，不直接共享宿主机网络。搜索、SB、提醒走现有后端工具。人物设定API和time_now不依赖沙箱，现有c0051ca修复仍待部署。

初始资源策略为全局1任务、单次256MiB/0.5CPU/64PID/30秒默认超时，最大值由服务端限定；这些是建议参数而非测试结果。超时或取消杀掉整个任务cgroup，限制stdout/stderr和trace大小。CPU/内存配额不自动解决持久目录磁盘配额，需要单独实施。

AppArmor限制只为安装后的受控执行器定向配置，不全局关闭限制。Bubblewrap/NsJail仍共享宿主机内核；陌生用户扩大前切换到经过压测的gVisor或独立执行节点。

## 开发前验收

1. 在专用测试目录验证userns/AppArmor、非root启动和资源限制；失败不自动退回宿主机执行。
2. Alice/Bob虚构目录互读互写失败；软链接、路径穿越、/proc进程及socket路径不能绕过。
3. 封闭环境中验证网络阻断、内网/元数据访问阻断、代理允许的公开站点访问。
4. 验证超时、子进程、资源耗尽和输出超限能终止；任务结束不遗留后台进程。
5. 测Python/Bash/依赖导入和文件持久化，记录启动延迟/RSS；原个人Pi和SB保持可用。
6. 新增cmd仅对合成用户启用，实际trace验证后再逐用户开通。

## 一手来源

- [Bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)：namespace、挂载与安全策略由调用者定义。
- [NsJail README](https://github.com/google/nsjail/blob/master/README.md)：资源限制与执行隔离。
- [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime/blob/main/README.md)：默认读取策略、Linux依赖和Ubuntu24.04 AppArmor条件。
- [Docker rootless](https://docs.docker.com/engine/security/rootless/)与[run参数](https://docs.docker.com/reference/cli/docker/container/run/)：daemon权限与资源配置。
- [gVisor性能模型](https://gvisor.dev/docs/architecture_guide/performance/)：用户态内核额外成本，不采用旧基准作为当前主机结果。
- [Firecracker前提](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)：KVM、guest kernel与rootfs。
- [OpenSandbox架构](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md)：管理层与运行时后端区别。
- [pi-safe](https://github.com/dimaginar/pi-safe)：默认全盘读取和网络不限制的边界。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：逐轮sandboxPolicy设置和移动端daemon接入协议。
