# PolarProcess

> **Polarisor 生态进程生命周期的唯一权威** — 在 Mac 本地 20+ 服务并行运行时，统一回答「谁在跑、挂了会不会自动拉起、Agent 重启服务会不会留下僵尸进程」。所有托管服务的启动、停止、重启、健康守护都经过这里（:11055）。

SOTAgent 擅长观测面板与 Git 同步，但不适合同时承担进程 spawn、健康探针和重启风暴防护。PolarProcess 从 SOTAgent 迁移 ProcessManager + Watchdog + Scheduler 模块，成为生态内**启停/守护/调度**的唯一执行层；SOTAgent 的 `/api/services/*` 仅为转发到本服务的 facade（console 展示用）。自身由 launchd 托管，Watchdog 自动扫描 `polaris.json` 中的 `health_endpoint`。

**GitHub:** [beichenO2/PolarProcess](https://github.com/beichenO2/PolarProcess)

## 职责边界

| 职责 | 归属 |
|------|------|
| 进程启/停/重启/自动拉起 | **本服务**（ProcessManager） |
| 健康守护与自愈 | **本服务**（Watchdog：30s 健康检查 + 60s stale 端口清扫） |
| 端口分配 | [PolarPort](https://github.com/beichenO2/PolarPort)（:11050），本服务只消费 |
| 前端展示 | SOTAgent console（:4880），只读 |

**Watchdog 目标发现**：扫描 `~/Polarisor/*/polaris.json` 的 `service_management.health_endpoint`（跳过 archived/deprecated）。连续 3 次失败自动执行 `restart_command`；5 分钟内 ≥10 次重启判定 crash loop，停止机械重启并发 lobster-event 交 PolarPilot Agentic 修复。**因此各项目 `health_endpoint` 的端口必须与实际监听一致**，写错会被误判反复重启。

> 端口冲突迁移走 PolarPort `/api/allocate`（`ProcessManager.claimPortFromPolarPort`）。`ServiceDB.allocatePort` 已废弃并会抛错，避免双事实源。

---

## 安装

### Polarisor 生态（推荐）

```bash
git clone https://github.com/beichenO2/Polarisor.git
cd Polarisor
./install.sh infra    # 安装 PolarProcess 及基础设施依赖
```

### 独立安装

```bash
git clone https://github.com/beichenO2/PolarProcess.git
cd PolarProcess
npm install
```

**环境要求：** Node.js ≥ 22 · 共享 ServiceDB 位于 `~/Polarisor/SOTAgent/data/resources.sqlite` · 可选 Tailscale（跨设备路由）

---

## 设计思考

### 为什么用原生进程 + launchd，而不是 Docker？

Polarisor 是 macOS 本地优先的开发环境。直接 `spawn` + HTTP 健康探针 + `nice`/`ulimit` 资源约束，内存开销远低于容器运行时，且与 launchd 常驻单元无缝集成。PolarProcess 自己崩溃时无法自愈——最外层看门人必须是 OS 级 launchd/systemd。

### 为什么 Agent 重启必须走 PolarProcess API，而不是 nohup/spawn？

直接拉起新进程会导致：**僵尸进程**（旧 PID 未 kill）、**僵尸端口**（PolarPort 心跳仍在续命）、**端口漂移**（新进程拿到新端口）。`POST /api/services/:id/restart` 执行 stop → release → start 原子流程，与 PolarPort stale sweep 联动。

### 为什么 Watchdog 与 ProcessManager 双层守护，而不是单一健康检查？

ProcessManager 管理**已注册服务**的 spawn/health/restart（5 次上限 · 15s 冷却 · 30min 衰减）。Watchdog 扫描**全生态 polaris.json**（30s 探针 · 连续 3 次失败重启 · 5 分钟内 10 次 → crash loop），并每 60s 对 PolarPort stale 端口做 TCP 探测 + 释放 + 重启。职责分层，避免单点逻辑过重。

---

## 核心亮点

| 维度 | 数据 |
|------|------|
| **REST API** | **18** 个端点（services · tasks · scheduler · watchdog · health） |
| **能力注册** | **11** 个 HTTP capability（start / stop / restart / kill / scheduler 等） |
| **Watchdog 探针** | 每 **30s** 扫描；连续 **3** 次失败触发重启 |
| **Crash Loop 保护** | **5** 分钟窗口内 **≥10** 次重启 → 放弃并写入 `lobster-events.jsonl` |
| **ProcessManager 重启** | 最多 **5** 次尝试 · **15s** 冷却 · **7200s** 静默重启窗口 |
| **Stale 端口清扫** | 每 **60s** 联动 PolarPort；90s 无心跳 + TCP 不可达 → release |
| **子系统** | ProcessManager · Watchdog · ResourceScheduler · ResourceProfiler · Command Guard |
| **自动化测试** | **27** 个测试（21 集成 + 6 契约，Vitest + AJV） |
| **默认端口** | **11055**（`polar-process` / PolarProcess） |

---

## 页面预览

> GUI 嵌入 [PolarCopilot](https://github.com/beichenO2/PolarCopilot) Hub Console 的进程/服务视图。用 Cursor **Open Folder** 打开本仓库根目录预览 Markdown 图片。

![Hub 进程视图 — PolarCopilot Console embed](screenshots/hub-dashboard.png)

---

## 架构

```
PolarProcess/
├── src/
│   ├── process-manager.ts       # 服务启停/健康检查/自动重启/跨设备转发
│   ├── watchdog.ts              # polaris.json 自动发现 + stale 端口清扫
│   ├── scheduler.ts             # 重任务队列 + 分时复用
│   ├── profiler.ts              # CPU/内存/GPU 资源画像采样
│   ├── command-guard.ts         # 启动命令白名单 + 路径规范化
│   ├── tailscale-client.ts      # 跨设备 Tailscale IP 发现
│   ├── service-db.ts            # 共享 ServiceDB（SOTAgent resources.sqlite）
│   ├── db.ts                    # 本地 ProcessDB（任务/调度状态）
│   └── server.ts                # Hono HTTP 服务（默认 :11055）
├── contracts/
│   ├── process-api.schema.json  # 服务/进程生命周期契约
│   ├── scheduler-api.schema.json
│   └── examples/
├── tests/
│   ├── integration/             # HTTP + ProcessManager 集成测试
│   └── contracts/               # JSON Schema 校验
├── capabilities.json            # 11 个 HTTP capability
├── polaris.json                 # SSoT 需求定义（R1–R4）
├── PolarSoul.md                 # 设计灵魂与决策记录
└── screenshots/                 # README 预览图
```

**数据流：**

```
Agent / 脚本 ──POST /api/services/:id/restart──▶ PolarProcess (:11055)
                                                    │ Watchdog 30s
                    PolarPort (:11050) ◀──stale sweep / release──┤
                    SOTAgent console (:4880) ◀──facade 只读──────┘
                              │
                       lobster-events.jsonl ──▶ PolarPilot Agentic 自愈
```

---

## 快速开始

```bash
npm install
bash Start/start.sh   # 生产：经 claim_port 取端口（preferred 11055）后台常驻
npm run dev           # 开发模式（tsx --watch）
npm run start         # 生产启动（端口由 PolarPort 分配，默认 :11055）
npm test              # 27 个契约 + 集成测试
```

通过 API 管理服务（**AI Agent 重启服务的唯一正确方式**）：

```bash
# 查看所有托管服务
curl http://127.0.0.1:11055/api/services

# 注册服务（command 中禁止硬编码端口）
curl -X POST http://127.0.0.1:11055/api/services -H 'Content-Type: application/json' -d '{...}'

# 重启服务（先 stop 再 start，原子操作）
curl -X POST http://127.0.0.1:11055/api/services/{service-id}/restart

# Watchdog 状态（自动发现的 polaris.json 目标）
curl http://127.0.0.1:11055/api/watchdog/status

# 健康检查
curl http://127.0.0.1:11055/api/health
```

> **⛔ 禁止**直接 `nohup node server.js &` 或 `kill -9` 后不释放 PolarPort 端口。行为规范见 `Agent_core/principles/ADVANCED.md` P27；最小挂载片段见 `Agent_core/reference/SERVICE-PORT-MINIMAL.md`。

---

## 生态依赖

| 项目 | 角色 | 是否必须 |
|------|------|----------|
| [PolarPort](https://github.com/beichenO2/PolarPort) | 端口分配唯一权威与 stale 端口联动 | 必须 |
| [SOTAgent](https://github.com/beichenO2/SOTAgent) | ServiceDB 共享存储 + console 前端展示（非操作权威） | 必须 |
| [Agent_core](https://github.com/beichenO2/Agent_core) | P27 硬约束与 Skill 集成（`pc-yolo-execute` 等） | 推荐 |
| [PolarPilot](https://github.com/beichenO2/PolarPilot) | 消费 `lobster-events.jsonl` 触发 Agentic 自愈 | 推荐 |
| [PolarCopilot](https://github.com/beichenO2/PolarCopilot) | Hub Console 进程视图 embed | 可选 |

---

## License

MIT
