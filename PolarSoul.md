# PolarProcess — PolarSoul

## 设计哲学

PolarProcess 是 Polarisor 的**进程生命周期管理器与守护者**。它的核心职责是确保生态内所有注册服务"活着"——启动它们、监控它们的健康、在它们崩溃时自动重启、在重启无效时发出告警。

- **进程守护**: Watchdog 定期健康检查 + 自动重启（带上限和退避）
- **多设备感知**: 通过 Tailscale 跨设备识别和进程路由
- **安全约束**: Command Guard 白名单验证启动命令，防止注入
- **状态持久化**: better-sqlite3 本地数据库记录服务注册、进程状态和调度任务

## 功能介绍

- **生态位**: 生态服务的守护核心——如果 PolarProcess 不运行，没有自动重启保护

| 编号 | 功能域 | 说明 |
|---|---|---|
| R1 | 进程生命周期 | spawn + health check + auto-restart + exponential backoff |
| R2 | Watchdog | 每 30s TCP 端口探测，连续 3 次失败触发重启（上限 10 次） |
| R3 | 多设备编排 | 通过 device_id + Tailscale IP 将进程启动请求路由到正确设备 |
| R4 | Command Guard | 启动命令白名单验证 + 路径规范化，防止命令注入 |
| R5 | Scheduler | 定时任务管理（如定期爬取触发） |
| R6 | Crash Loop 检测 | 5 分钟窗口内重启 >= 10 次时放弃，发 lobster-event 通知 PolarPilot |

## 与其他项目的关系

- **与 SOTAgent 互补**: SOTAgent 是服务发现/端口分配的注册中心（port 4800），PolarProcess 是实际执行启停和守护的进程管理器（port 11055）
- **与 PolarPilot Daemon 不同**: PolarPilot Daemon 监控"代码是否编译通过"，PolarProcess 监控"进程是否在跑"
- **自身不可守护**: PolarProcess 自己崩溃时无法自愈——需依赖 launchd 或 systemd 作为最外层看门人

## 关键设计决策

### 为什么操作系统层而非容器层

**问题**: Docker 提供更强隔离但增加运行时开销和复杂度。

**决策**: macOS 环境直接使用进程控制（spawn + nice/ulimit），更轻量且与 launchd 兼容。

**不可妥协**: 受控进程不能无限消耗系统资源。

### Node.js 版本与 native module

**问题**: better-sqlite3 是 C++ native module，编译时绑定具体 Node.js 版本（NODE_MODULE_VERSION）。

**决策**: package.json `engines.node >= 22`，start.sh 通过 nvm 自动选择匹配版本。native module 必须用对应版本的 node-gyp 编译（`npx node-gyp rebuild --directory=node_modules/better-sqlite3`）。

**不可妥协**: native module 的 NODE_MODULE_VERSION 必须与运行时 Node.js 一致，否则 ERR_DLOPEN_FAILED。

## 依赖与被依赖

### 依赖

| 依赖项 | 说明 |
|---|---|
| better-sqlite3 | 本地状态持久化（需 Node 22 对应的 native 编译） |
| Tailscale | 跨设备通信和 IP 发现 |

### 被依赖

| 被依赖项 | 说明 |
|---|---|
| 所有生态服务 | 进程守护 + 自动重启（Clock、DiGist、KnowLever 等） |
| SOTAgent | 通过 API 注册服务后由 PolarProcess 实际管理进程生命周期 |

---

## 详情入口

- [SSoT](polaris.json)

_维护者_: Agent/PolarCopilot
_最后更新_: 2026-06-10
