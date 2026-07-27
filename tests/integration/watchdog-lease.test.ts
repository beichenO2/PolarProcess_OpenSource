import { describe, expect, it } from 'vitest';
import { isAuthorityProject, parseSqliteUtcTimestamp } from '../../src/watchdog.js';

describe('watchdog runtime authority boundaries', () => {
  it('parses SQLite timestamps without an offset as UTC', () => {
    expect(parseSqliteUtcTimestamp('2026-07-27 04:47:34')).toBe(
      Date.parse('2026-07-27T04:47:34Z'),
    );
  });

  it('preserves an explicit timestamp offset', () => {
    expect(parseSqliteUtcTimestamp('2026-07-27 04:47:34+08:00')).toBe(
      Date.parse('2026-07-26T20:47:34Z'),
    );
  });

  it('fails closed for invalid timestamps', () => {
    expect(parseSqliteUtcTimestamp('not-a-timestamp')).toBeNull();
    expect(parseSqliteUtcTimestamp('')).toBeNull();
  });

  it('recognizes only the two launchd-owned authority projects', () => {
    expect(isAuthorityProject('PolarPort')).toBe(true);
    expect(isAuthorityProject('polarprocess')).toBe(true);
    expect(isAuthorityProject('TaoCi')).toBe(false);
    expect(isAuthorityProject('PolarPort-application')).toBe(false);
  });
});
