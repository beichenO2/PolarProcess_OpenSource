import { describe, expect, it } from 'vitest';
import { LogDeduper } from '../../src/log-dedup.js';
import { ProcessManager } from '../../src/process-manager.js';

describe('LogDeduper', () => {
  it('suppresses repeats inside the window and summarizes later', () => {
    const lines: string[] = [];
    const d = new LogDeduper(60_000, (l) => lines.push(l));
    expect(d.emit('k', 'first')).toBe(true);
    expect(d.emit('k', 'second')).toBe(false);
    expect(d.emit('k', 'third')).toBe(false);
    expect(lines).toEqual(['first']);

    // force window expiry
    (d as unknown as { lastAt: Map<string, number> }).lastAt.set('k', Date.now() - 61_000);
    expect(d.emit('k', 'fourth')).toBe(true);
    expect(lines[1]).toContain('suppressed 2');
    expect(lines[2]).toBe('fourth');
  });
});

describe('ephemeral GC predicates', () => {
  it('only matches cursor-cli- / rr-cursor- prefixes', () => {
    expect(ProcessManager.isEphemeralServiceId('cursor-cli-abc-composer')).toBe(true);
    expect(ProcessManager.isEphemeralServiceId('rr-cursor-rr-mcp-agent-x')).toBe(true);
    expect(ProcessManager.isEphemeralServiceId('intervene-wiki')).toBe(false);
    expect(ProcessManager.isEphemeralServiceId('polarflow-api')).toBe(false);
  });

  it('treats missing work_dir as script-missing', () => {
    expect(
      ProcessManager.ephemeralStartScriptMissing({
        id: 'cursor-cli-x',
        name: 'x',
        command: 'true',
        work_dir: '/nonexistent/path/for-polarprocess-gc-test',
        mem_requirement_mb: 0,
        gpu_mem_requirement_mb: 0,
        status: 'error',
        pid: null,
        port: null,
        device_id: 'any',
        auto_start: 0,
        restart_on_failure: 0,
        max_restarts: 0,
        restart_count: 0,
        started_at: null,
        last_used: null,
        last_health_check: null,
        health_check_url: null,
        cron_schedule: null,
        last_exit_code: 1,
        last_error: 'missing',
        restart_count_updated_at: null,
        pending_restart: 0,
        last_change_at: null,
        start_script_dir: 'Start',
      }),
    ).toBe(true);
  });
});
