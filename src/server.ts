/**
 * server.ts — PolarProcess Hono server.
 *
 * Mounts service/process/task/scheduler endpoints.
 * Now the sole owner of ProcessManager lifecycle (migrated from SOTAgent).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { ProcessDB } from './db.js';
import { ServiceDB } from './service-db.js';
import { ProcessManager, type IProcessStatus, type IServiceActionResult, type IProcessManagerConfig } from './process-manager.js';
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { Watchdog } from './watchdog.js';

const DATA_DIR = process.env.POLARPROCESS_DATA_DIR
  ?? path.join(process.env.HOME ?? '', 'Polarisor', 'PolarProcess', 'data');
const DB_PATH = process.env.POLARPROCESS_DB ?? path.join(DATA_DIR, 'process.sqlite');
const SHARED_DB_PATH = process.env.POLARPROCESS_SHARED_DB
  ?? path.join(process.env.HOME ?? '', 'Polarisor', 'SOTAgent', 'data', 'resources.sqlite');
/** Infrastructure pin — never accept PolarPort sticky/alternate ports. */
const FIXED_PORT = Number(process.env.POLARPROCESS_PORT ?? 11055);
const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

const PM_CONFIG: IProcessManagerConfig = {
  process_manager: {
    health_check_interval_sec: 30,
    auto_start_delay_sec: 5,
    max_restart_attempts: 5,
    restart_cooldown_sec: 15,
    restart_decay_min: 30,
    startup_grace_sec: 30,
  },
  silent_restart_window_sec: 7200,
};

export type PolarProcessApp = Hono & { startLifecycle: () => void };

export function createApp(db: ProcessDB, serviceDb: ServiceDB): PolarProcessApp {
  const app = new Hono() as PolarProcessApp;
  const deviceId = process.env['SOTAGENT_DEVICE_ID'] || os.hostname().split('.')[0] || os.hostname();
  const profiler = new ResourceProfiler(db);
  const scheduler = new ResourceScheduler(db, deviceId, profiler);

  // ─── Health ──────────────────────────────────────
  app.get('/api/health', (c) => c.json({ ok: true, service: 'polar-process' }));

  // ─── Tasks ───────────────────────────────────────
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status');
    const tasks = scheduler.listTasks(status);
    return c.json(tasks);
  });

  app.post('/api/tasks/create', async (c) => {
    const body = await c.req.json();
    const result = scheduler.createTask(body);
    return c.json(result);
  });

  app.get('/api/tasks/:id/status', (c) => {
    const id = c.req.param('id');
    const task = scheduler.getTask(id);
    if (!task) return c.json({ ok: false, message: `task ${id} not found` }, 404);
    return c.json(task);
  });

  app.post('/api/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    const result = scheduler.cancelTask(id);
    return c.json(result);
  });

  // ─── Scheduler ───────────────────────────────────
  app.get('/api/scheduler/status', (c) => {
    const status = scheduler.getStatus();
    return c.json(status);
  });

  app.get('/api/scheduler/queue', (c) => {
    const tasks = scheduler.listTasks('queued');
    return c.json(tasks);
  });

  app.post('/api/scheduler/config', async (c) => {
    const body = await c.req.json();
    scheduler.updateConfig(body);
    return c.json({ ok: true });
  });

  // ─── Watchdog ─────────────────────────────────
  const watchdog = new Watchdog();
  watchdog.discoverTargets().then(n => {
    console.log(`[Watchdog] Discovered ${n} targets`);
    watchdog.start();
  });

  app.get('/api/watchdog/status', (c) => c.json(watchdog.getStatus()));

  app.post('/api/watchdog/rediscover', async (c) => {
    const n = await watchdog.discoverTargets();
    return c.json({ ok: true, discovered: n, total: watchdog.getStatus().length });
  });

  app.post('/api/watchdog/pause/:service', (c) => {
    watchdog.pause(c.req.param('service'));
    return c.json({ ok: true, message: `paused watchdog for ${c.req.param('service')}` });
  });

  app.post('/api/watchdog/resume/:service', (c) => {
    watchdog.resume(c.req.param('service'));
    return c.json({ ok: true, message: `resumed watchdog for ${c.req.param('service')}` });
  });

  // ─── Services (Process Management — Full lifecycle) ─────────────
  const pm = new ProcessManager(serviceDb, PM_CONFIG);

  app.get('/api/services', (c) => {
    const services = pm.getAllStatus();
    return c.json(services);
  });

  app.get('/api/services/:id', (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    return c.json(svc);
  });

  app.post('/api/services/:id/start', async (c) => {
    const id = c.req.param('id');
    const result = await pm.startService(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/stop', async (c) => {
    const id = c.req.param('id');
    const result = await pm.stopService(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/restart', async (c) => {
    const id = c.req.param('id');
    const result = await pm.restartService(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  app.post('/api/services/:id/reset-restart-count', (c) => {
    const id = c.req.param('id');
    const svc = serviceDb.getService(id);
    if (!svc) return c.json({ ok: false, message: `service ${id} not found` }, 404);
    serviceDb.updateServiceRestartCount(id, 0);
    return c.json({ ok: true, message: `restart count reset for ${svc.name}` });
  });

  app.post('/api/services/register', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    serviceDb.registerService(body);
    return c.json({ ok: true, message: `service ${body.name} registered`, id: body.id });
  });

  app.post('/api/services/register-and-start', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    serviceDb.registerService(body);
    const result = await pm.startService(body.id);
    return c.json({ ...result, id: body.id }, result.ok ? 200 : 500);
  });

  // Backward compat: SOTAgent bridge proxies POST /api/services here
  app.post('/api/services', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.name || !body.command) {
      return c.json({ ok: false, message: 'id, name and command are required' }, 400);
    }
    serviceDb.registerService(body);
    return c.json({ ok: true, message: `service ${body.name} registered`, id: body.id });
  });

  // Lifecycle starts AFTER listen (see main) so autoStartAll cannot starve accept.
  app.startLifecycle = () => {
    pm.startHealthCheckLoop();
    pm.startCronLoop();
    pm.startSilentWindowLoop();
    pm.startSandboxMonitor();
    void pm.autoStartAll().then(started => {
      if (started.length > 0) {
        console.log(`[PolarProcess] 自启动了 ${started.length} 个服务: ${started.join(', ')}`);
      }
    }).catch(err => {
      console.error('[PolarProcess] autoStartAll failed:', err);
    });
  };

  return app;
}

/** Best-effort registry hygiene. Never bind whatever PolarPort returns. */
async function announceFixedPort(port: number): Promise<void> {
  try {
    // Drop sticky alternate ports left from prior claim_port reuse (8000/8030).
    const listed = await fetch(`${POLARPORT_URL}/api/list`, { signal: AbortSignal.timeout(3000) });
    if (listed.ok) {
      const body = (await listed.json()) as
        | Array<{ port?: number; service_name?: string }>
        | { ports?: Array<{ port?: number; service_name?: string }> };
      const rows = Array.isArray(body) ? body : (body.ports ?? []);
      for (const row of rows) {
        if (row.service_name === 'polar-process' && typeof row.port === 'number' && row.port !== port) {
          await fetch(`${POLARPORT_URL}/api/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: row.port }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => undefined);
          console.warn(`[PolarProcess] released stale PolarPort claim on ${row.port}`);
        }
      }
    }

    const r = await fetch(`${POLARPORT_URL}/api/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_name: 'polar-process',
        project: 'PolarProcess',
        preferred_port: port,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return;
    const data = (await r.json()) as { ok?: boolean; port?: number };
    if (data.port != null && data.port !== port) {
      console.warn(
        `[PolarProcess] PolarPort returned ${data.port} for polar-process; releasing sticky claim — pinned to ${port}`,
      );
      await fetch(`${POLARPORT_URL}/api/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: data.port }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
      // Second pass: prefer FIXED_PORT after sticky row is released
      await fetch(`${POLARPORT_URL}/api/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_name: 'polar-process',
          project: 'PolarProcess',
          preferred_port: port,
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
    }
  } catch {
    /* PolarPort unreachable — fine; we already listen on FIXED_PORT */
  }
}

async function registerCapabilities(port: number): Promise<void> {
  const sotagentBase = process.env.SOTAGENT_URL ?? 'http://127.0.0.1:4800';
  try {
    const caps = (await import('../capabilities.json', { with: { type: 'json' } })).default;
    await fetch(`${sotagentBase}/api/capabilities/register-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'PolarProcess',
        service_name: 'polar-process',
        capabilities: caps.capabilities,
      }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[PolarProcess] Capabilities registered with SOTAgent`);
  } catch {
    console.log(`[PolarProcess] SOTAgent not reachable, skipping capability registration`);
  }
}

async function main(): Promise<void> {
  const db = new ProcessDB(DB_PATH);

  if (!existsSync(SHARED_DB_PATH)) {
    console.error(`[PolarProcess] FATAL: shared DB not found at ${SHARED_DB_PATH}`);
    process.exit(1);
  }
  const serviceDb = new ServiceDB(SHARED_DB_PATH);
  console.log(`[PolarProcess] ServiceDB opened: ${SHARED_DB_PATH}`);

  if (!Number.isFinite(FIXED_PORT) || FIXED_PORT <= 0) {
    console.error(`[PolarProcess] FATAL: invalid POLARPROCESS_PORT=${process.env.POLARPROCESS_PORT}`);
    process.exit(1);
  }

  const app = createApp(db, serviceDb);
  const port = FIXED_PORT;

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`PolarProcess listening on http://127.0.0.1:${info.port} (pinned, skip PolarPort claim)`);
    app.startLifecycle();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[PolarProcess] FATAL listen error on ${port}:`, err.message);
    process.exit(1);
  });

  void announceFixedPort(port);
  await registerCapabilities(port);
}

if (import.meta.url.endsWith(process.argv[1] ?? '') || (process.argv[1] ?? '').includes('server')) {
  void main();
}
