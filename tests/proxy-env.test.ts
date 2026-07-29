import { describe, expect, it } from 'vitest';
import {
  applyOutboundProxy,
  parseProxyMode,
  parseScutilProxyOutput,
} from '../src/proxy-env.js';

describe('parseProxyMode', () => {
  it('defaults to on', () => {
    expect(parseProxyMode([], {})).toBe('on');
  });

  it('reads env POLAR_PROXY_MODE', () => {
    expect(parseProxyMode([], { POLAR_PROXY_MODE: 'auto' })).toBe('auto');
    expect(parseProxyMode([], { POLAR_PROXY_MODE: 'off' })).toBe('off');
  });

  it('reads CLI flags', () => {
    expect(parseProxyMode(['--no-proxy'], {})).toBe('off');
    expect(parseProxyMode(['--proxy=auto'], {})).toBe('auto');
  });
});

describe('parseScutilProxyOutput', () => {
  it('builds proxy URLs from scutil output', () => {
    const raw = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7892
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7892
  HTTPSProxy : 127.0.0.1
}`;
    expect(parseScutilProxyOutput(raw)).toEqual({
      http: 'http://127.0.0.1:7892',
      https: 'http://127.0.0.1:7892',
    });
  });
});

describe('applyOutboundProxy', () => {
  const baseEnv = (): NodeJS.ProcessEnv => ({});

  it('does nothing when mode is off', () => {
    const env = baseEnv();
    const result = applyOutboundProxy('off', env);
    expect(result.applied).toBe(false);
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it('applies override URLs in on mode', () => {
    const env = baseEnv();
    env.POLAR_HTTP_PROXY = 'http://127.0.0.1:7892';
    env.POLAR_HTTPS_PROXY = 'http://127.0.0.1:7892';
    const result = applyOutboundProxy('on', env);
    expect(result.applied).toBe(true);
    expect(result.source).toBe('override');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7892');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7892');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('keeps existing env in auto mode', () => {
    const env = baseEnv();
    env.HTTP_PROXY = 'http://proxy.example:8080';
    env.HTTPS_PROXY = 'http://proxy.example:8080';
    const result = applyOutboundProxy('auto', env);
    expect(result.applied).toBe(false);
    expect(result.source).toBe('existing');
  });
});
