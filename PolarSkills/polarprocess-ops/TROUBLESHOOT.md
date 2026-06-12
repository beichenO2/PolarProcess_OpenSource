# PolarProcess — 故障排查

> 进程启停/健康检查/远程转发 + 重任务队列 + Watchdog 监控

## 健康检查

```bash
# 进程存活
pgrep -f "PolarProcess" || echo "NOT RUNNING"

# HTTP 端点
curl -s http://127.0.0.1:11055/api/health
```

## 关键端口

| 端口 | 说明 |
|---|---|
| 11055 | PolarProcess 主服务 |

## 常见故障

### 1. Watchdog 误杀进程

**修复**：`检查 crash loop 计数器，调整 ThrottleInterval`

### 2. 任务队列堆积

**修复**：`查看 /api/tasks?status=pending`

### 3. 远程转发失败

**修复**：`确认 Tailscale 连接 + 目标设备 PolarProcess 运行中`

## 依赖服务

- Tailscale (跨设备)
- SOTAgent (服务发现)

## 紧急恢复

```bash
cd ~/Polarisor/PolarProcess
npm start
curl -s http://127.0.0.1:11055/api/health && echo 'OK' || echo 'BROKEN'
```
