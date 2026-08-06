# PolarProcess Runtime Heal Implementation Plan

> **For agentic workers:** Steps use checkbox syntax. Every step has **验收门禁** — fail closed.

**Goal:** PolarProcess 重新被 launchd 监管；日志/Watchdog 可运维；僵尸注册可安全清扫且关键真实服务可恢复。

**Architecture:** Apple launchd 前台 `exec` + `KeepAlive=true`（权威服务）；日志用 size-based rotate + Watchdog 去抖；注册表用显式 deregister API + 安全 sweep（Eureka lease / tombstone 思路，仅清 ephemeral id）。

**Tech Stack:** launchd LaunchAgent, bash Start/start.sh, Hono PolarProcess, SQLite `shared_services`, newsize/copytruncate logrotate

**SOTA 检索（已执行）:**
| 主题 | 术语 | 关键结论 |
|---|---|---|
| 进程监管 | `launchd KeepAlive SuccessfulExit ThrottleInterval` / Apple TN2083 | **禁止自 daemonize**；权威服务宜 `KeepAlive=true`；`exit 0` + `SuccessfulExit=false` = 永久脱离 |
| 日志 | `log rotation rate limiting structured logging pino-roll` | size/time rotate；高频重复事件 **rate-limit / sample** |
| 注册表 | `service registry stale entry TTL eviction Eureka lease tombstone` | heartbeat+TTL 或显式 deregister；sweep 要事务 + 再校验 |

---

## 基线（Step0 已测）

- Health OK，但 `launchctl print …polarprocess` → `state=not running`；node PPID=1
- `polarprocess.log` ≈ 424MB
- `shared_services` ≈ 288 行；大量 `cursor-cli-*` / `rr-cursor-*` error/stopped；**无 HTTP deregister**

---

### Task 1: 重挂 launchd

**Files:**
- Modify: `Start/start.sh`
- Modify (可选): `~/Library/LaunchAgents/com.polarisor.polarprocess.plist` → `KeepAlive=true`

- [ ] **1.1** `LAUNCHD=1` 时若端口被本服务孤儿占用：先优雅停再 `exec`；被第三方占用：`exit 78`（非 0）
- [ ] **1.2** 运维：停孤儿 → `launchctl kickstart -k gui/$(id -u)/com.polarisor.polarprocess`
- [ ] **验收 V1**
  ```bash
  curl -fsS http://127.0.0.1:11055/api/health   # ok
  launchctl print "gui/$(id -u)/com.polarisor.polarprocess" | rg 'state = running|pid = '
  # PID 必须与 lsof -iTCP:11055 一致，且 PPID 为 launchd 作业树（非长期孤儿挂在 1 且 label inactive）
  LISTEN_PID=$(lsof -nP -iTCP:11055 -sTCP:LISTEN -t | head -1)
  launchctl print "gui/$(id -u)/com.polarisor.polarprocess" | rg -q "pid = $LISTEN_PID|pids = .*${LISTEN_PID}"
  ```

---

### Task 2: 日志 / Watchdog 降噪

**Files:**
- Modify: `Start/start.sh`（启动前 rotate）
- Modify: `src/watchdog.ts` / `src/process-manager.ts`（重复日志去抖）
- Create: `Start/logrotate.conf` 或内置 `rotate_log_if_huge`

- [ ] **2.1** 现有 424MB：`mv` 归档 + 新文件；保留最近 2 个归档，单文件硬顶 50MB
- [ ] **2.2** Watchdog：同 service+cause 60s 内最多 1 条 info；升级仍打 warn
- [ ] **验收 V2**
  ```bash
  ls -lh Start/polarprocess.log Start/polarprocess.log.*.gz 2>/dev/null
  # active log < 50MB after rotate
  # 人为触发同一 port_conflict 两次：60s 内只多 1 行同类 [Watchdog]（或计数器摘要）
  ```

---

### Task 3: 僵尸注册 + 真实服务

**Files:**
- Modify: `src/service-db.ts` — `deleteService`
- Modify: `src/process-manager.ts` — `unregisterService`（先 stop）
- Modify: `src/server.ts` — `DELETE /api/services/:id` + `POST /api/services/sweep-ephemeral`
- Modify: tests

**安全策略（不可砍持久项目服务）:**
- 仅允许 id 匹配：`^(cursor-cli-|rr-cursor-)` 且 status∈{error,stopped} 且 work_dir/start 脚本不可用
- 其它服务必须显式 `DELETE` + `confirm=id`

- [ ] **3.1** 实现 deregister API + 单测
- [ ] **3.2** dry-run sweep → 打印候选 → 执行
- [ ] **3.3** 对用户点名真实服务（如 `intervene-wiki`）单独诊断/修复，不批量误杀
- [ ] **验收 V3**
  ```bash
  BEFORE=$(curl -fsS http://127.0.0.1:11055/api/services | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
  curl -fsS -X POST http://127.0.0.1:11055/api/services/sweep-ephemeral -H 'Content-Type: application/json' -d '{"dry_run":true}'
  curl -fsS -X POST http://127.0.0.1:11055/api/services/sweep-ephemeral -H 'Content-Type: application/json' -d '{"dry_run":false}'
  AFTER=$(...)
  # cursor-cli-* error 且缺脚本者应 ≈0；running 的非 ephemeral 服务数不下降
  curl -fsS http://127.0.0.1:11055/api/services/intervene-wiki | python3 -m json.tool
  ```

---

### Task 4: Critic 门禁（强制三问）

每个子代理收尾必须书面回答：
1. 在这个场景下合适吗？
2. 设身处地：若你是用户，做得怎么样（1–5）？
3. 上网搜索了吗？用了哪些术语？有没有更好方案未采纳及原因？

---

## Execution Record (2026-07-30)

| Gate | Result | Evidence |
|---|---|---|
| V1 launchd | PASS | state=running; listen child of job pid; health OK |
| V2 logs | PASS | active ~1KB + gz archive; unit tests 3/3 |
| V3 sweep | PASS | 288→87; ephemeral→0; persistent running lost none; DELETE guard 409 |

Code: `Start/start.sh`, LaunchAgent plist KeepAlive=true, `src/log-dedup.ts`, process-manager/service-db/server, unit tests.
