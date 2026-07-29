import { execFileSync } from 'node:child_process';

export type ProxyMode = 'on' | 'off' | 'auto';

export interface ProxyEnvSnapshot {
  mode: ProxyMode;
  applied: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  source: 'disabled' | 'existing' | 'system' | 'override' | 'none';
}

let lastSnapshot: ProxyEnvSnapshot | null = null;

export function getProxyEnvSnapshot(): ProxyEnvSnapshot | null {
  return lastSnapshot;
}

export function parseProxyMode(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ProxyMode {
  for (const arg of argv) {
    if (arg === '--no-proxy') return 'off';
    if (arg.startsWith('--proxy=')) {
      const value = arg.slice('--proxy='.length).trim().toLowerCase();
      if (value === 'on' || value === 'off' || value === 'auto') return value;
      throw new Error(`invalid --proxy value: ${value}`);
    }
  }
  const fromEnv = (env.POLAR_PROXY_MODE ?? 'on').trim().toLowerCase();
  if (fromEnv === 'on' || fromEnv === 'off' || fromEnv === 'auto') return fromEnv;
  if (!fromEnv) return 'on';
  throw new Error(`invalid POLAR_PROXY_MODE: ${fromEnv}`);
}

export function parseScutilProxyOutput(raw: string): { http?: string; https?: string } {
  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    values[match[1]!] = match[2]!;
  }

  const buildUrl = (enabledKey: string, hostKey: string, portKey: string): string | undefined => {
    if (values[enabledKey] !== '1') return undefined;
    const host = values[hostKey]?.trim();
    const port = values[portKey]?.trim();
    if (!host || !port) return undefined;
    return `http://${host}:${port}`;
  };

  return {
    http: buildUrl('HTTPEnable', 'HTTPProxy', 'HTTPPort'),
    https: buildUrl('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'),
  };
}

export function readMacOsSystemProxy(): { http?: string; https?: string } {
  if (process.platform !== 'darwin') return {};
  try {
    const raw = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return parseScutilProxyOutput(raw);
  } catch {
    return {};
  }
}

function readOverrideProxy(env: NodeJS.ProcessEnv): { http?: string; https?: string } {
  const http = env.POLAR_HTTP_PROXY?.trim();
  const https = env.POLAR_HTTPS_PROXY?.trim();
  return {
    ...(http ? { http } : {}),
    ...(https ? { https: https } : {}),
  };
}

function ensureLocalNoProxy(env: NodeJS.ProcessEnv): void {
  const local = '127.0.0.1,localhost,*.local';
  const current = env.NO_PROXY?.trim();
  if (!current) {
    env.NO_PROXY = local;
    return;
  }
  const parts = new Set(current.split(',').map((part) => part.trim()).filter(Boolean));
  for (const part of local.split(',')) parts.add(part);
  env.NO_PROXY = [...parts].join(',');
}

export function applyOutboundProxy(mode: ProxyMode, env: NodeJS.ProcessEnv = process.env): ProxyEnvSnapshot {
  if (mode === 'off') {
    lastSnapshot = { mode, applied: false, source: 'disabled' };
    return lastSnapshot;
  }

  const override = readOverrideProxy(env);
  const hasOverride = Boolean(override.http || override.https);
  const existingHttp = env.HTTP_PROXY?.trim();
  const existingHttps = env.HTTPS_PROXY?.trim();

  if (mode === 'auto' && existingHttp && existingHttps && !hasOverride) {
    lastSnapshot = {
      mode,
      applied: false,
      httpProxy: existingHttp,
      httpsProxy: existingHttps,
      source: 'existing',
    };
    return lastSnapshot;
  }

  const system = hasOverride ? override : readMacOsSystemProxy();
  const httpProxy = system.https ?? system.http;
  const httpsProxy = system.https ?? system.http;

  if (!httpProxy && !httpsProxy) {
    lastSnapshot = { mode, applied: false, source: 'none' };
    return lastSnapshot;
  }

  if (httpProxy) env.HTTP_PROXY = httpProxy;
  if (httpsProxy) env.HTTPS_PROXY = httpsProxy;
  env.NODE_USE_ENV_PROXY = '1';
  ensureLocalNoProxy(env);

  lastSnapshot = {
    mode,
    applied: true,
    httpProxy: env.HTTP_PROXY,
    httpsProxy: env.HTTPS_PROXY,
    source: hasOverride ? 'override' : 'system',
  };
  return lastSnapshot;
}

export function bootstrapOutboundProxy(argv: readonly string[] = process.argv.slice(2)): ProxyEnvSnapshot {
  const mode = parseProxyMode(argv);
  return applyOutboundProxy(mode);
}
