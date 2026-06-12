# PolarProcess

Process lifecycle management, resource scheduling, and system profiling service for the Polarisor ecosystem.

Migrated from SOTAgent's `process-manager.ts`, `scheduler.ts`, `profiler.ts`, `command-guard.ts`, and `tailscale-client.ts`.

## Endpoints

### Services
- `GET /api/services` — list all managed services
- `POST /api/services/:id/start` — start a service
- `POST /api/services/:id/stop` — stop a service
- `POST /api/services/:id/restart` — restart a service

### Processes
- `GET /api/processes` — list all processes
- `GET /api/processes/:id` — get process status
- `POST /api/processes/:id/kill` — kill a process

### Tasks (Heavy Task Queue)
- `GET /api/tasks` — list tasks
- `POST /api/tasks/create` — create a heavy task
- `POST /api/tasks/:id/cancel` — cancel a task
- `GET /api/tasks/:id/status` — get task status

### Scheduler
- `GET /api/scheduler/status` — scheduler status
- `GET /api/scheduler/queue` — task queue
- `POST /api/scheduler/config` — update scheduler config

### Health
- `GET /api/health` — service health check

## Quick Start

```bash
npm install
npm run dev
```

The server starts on a port allocated by PolarPort (`POST /api/allocate`).
