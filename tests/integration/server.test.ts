import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessDB } from '../../src/db.js';
import { ProcessManager } from '../../src/process-manager.js';
import { ResourceScheduler } from '../../src/scheduler.js';
import { ResourceProfiler } from '../../src/profiler.js';
import { createApp } from '../../src/server.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_DB = path.join(os.tmpdir(), `polarprocess-test-${Date.now()}.sqlite`);

describe('PolarProcess integration', () => {
  let db: ProcessDB;

  beforeAll(() => {
    db = new ProcessDB(TEST_DB);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  describe('ProcessManager', () => {
    it('registers and lists services', async () => {
      const pm = new ProcessManager(db);
      const result = await pm.registerService({
        id: 'test-svc-1',
        name: 'Test Service',
        command: 'echo hello',
        device_id: 'local',
      });
      expect(result.ok).toBe(true);

      const services = pm.listServices();
      expect(services.length).toBe(1);
      expect(services[0]!.id).toBe('test-svc-1');
      expect(services[0]!.status).toBe('stopped');
    });

    it('stops a service', async () => {
      const pm = new ProcessManager(db);
      const result = await pm.stopService('test-svc-1');
      expect(result.ok).toBe(true);
    });

    it('kills a process', async () => {
      const pm = new ProcessManager(db);
      const result = await pm.killProcess('test-svc-1');
      expect(result.ok).toBe(true);
    });
  });

  describe('ResourceScheduler', () => {
    it('creates a task', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const result = scheduler.createTask({
        task_type: 'test-task',
        command: 'echo test',
        priority: 5,
      });
      expect(result.ok).toBe(true);
      expect(result.task_id).toBeTruthy();
    });

    it('lists tasks', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const tasks = scheduler.listTasks('queued');
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it('cancels a task', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const tasks = scheduler.listTasks('queued');
      const taskId = tasks[0]!.task_id;
      const result = scheduler.cancelTask(taskId);
      expect(result.ok).toBe(true);
    });

    it('returns scheduler status', () => {
      const profiler = new ResourceProfiler(db);
      const scheduler = new ResourceScheduler(db, 'test-device', profiler);
      const status = scheduler.getStatus();
      expect(status).toHaveProperty('idle');
      expect(status).toHaveProperty('running_tasks');
      expect(status).toHaveProperty('queue_depth');
    });
  });

  describe('Hono app', () => {
    it('health check returns ok', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/health'));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe('polar-process');
    });

    it('GET /api/services returns array', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/services'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/tasks returns array', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/tasks'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/scheduler/status returns status', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/status'));
      const body = await res.json();
      expect(body).toHaveProperty('idle');
      expect(body).toHaveProperty('running_tasks');
      expect(body).toHaveProperty('queue_depth');
    });

    it('POST /api/services/register registers a service', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/services/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'integration-test-svc',
          name: 'Integration Test Service',
          command: 'sleep 999',
          device_id: 'local',
        }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('GET /api/processes/:id returns 404 for unknown id', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/processes/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('POST /api/services/:id/start returns result', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/start', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/services/:id/stop returns result', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/stop', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/services/:id/restart returns result', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/services/integration-test-svc/restart', { method: 'POST' }));
      const body = await res.json();
      expect(body).toHaveProperty('ok');
    });

    it('POST /api/tasks/create creates a task via HTTP', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'http-test', command: 'echo hi', priority: 3 }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.task_id).toBeTruthy();
    });

    it('GET /api/tasks/:id/status returns task or 404', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/tasks/nonexistent-task/status'));
      expect(res.status).toBe(404);
    });

    it('POST /api/tasks/:id/cancel via HTTP', async () => {
      const app = createApp(db);
      const createRes = await app.fetch(new Request('http://localhost/api/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'cancel-test', command: 'sleep 99', priority: 1 }),
      }));
      const created = await createRes.json();
      const cancelRes = await app.fetch(new Request('http://localhost/api/tasks/' + created.task_id + '/cancel', { method: 'POST' }));
      const body = await cancelRes.json();
      expect(body.ok).toBe(true);
    });

    it('GET /api/scheduler/queue returns array', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/queue'));
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('POST /api/scheduler/config updates config', async () => {
      const app = createApp(db);
      const res = await app.fetch(new Request('http://localhost/api/scheduler/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_concurrent: 4 }),
      }));
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });
});
