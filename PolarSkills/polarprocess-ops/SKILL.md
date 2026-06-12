# PolarProcess — 使用指南

> 进程启停/健康检查/远程转发 + 重任务队列 + Watchdog 监控

## 核心信息

| 维度 | 值 |
|---|---|
| 健康端点 | 端口 11055（/api/health） |
| 启动命令 | `npm start` |
| 安装命令 | `npm ci` |
| 技术栈 | Node.js v22+, TypeScript, better-sqlite3 |

## 快速启动

```bash
cd ~/Polarisor/PolarProcess
npm ci
npm start
```

## 健康检查

```bash
curl -s http://127.0.0.1:11055/api/health
```

## 依赖服务

- Tailscale (跨设备)
- SOTAgent (服务发现)
