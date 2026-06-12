# PolarProcess — 部署指南

> 进程启停/健康检查/远程转发 + 重任务队列 + Watchdog 监控

## 环境要求

- 技术栈：Node.js v22+, TypeScript, better-sqlite3
- 安装：`npm ci`

## 安装步骤

```bash
cd ~/Polarisor/PolarProcess
npm ci
```

## 启动方式

### launchd 常驻（推荐）

plist：`~/Library/LaunchAgents/com.polarisor.polarprocess.plist`

```bash
launchctl load ~/Library/LaunchAgents/com.polarisor.polarprocess.plist
launchctl start com.polarisor.polarprocess
```

### 手动启动

```bash
cd ~/Polarisor/PolarProcess
npm start
```

## 端口分配

| 端口 | 用途 |
|---|---|
| 11055 | 主服务 |

## 健康检查确认

```bash
curl -s http://127.0.0.1:11055/api/health
```

## 回滚方式

```bash
cd ~/Polarisor/PolarProcess
git log --oneline -5
git checkout <previous-commit>
npm ci
npm start
```
