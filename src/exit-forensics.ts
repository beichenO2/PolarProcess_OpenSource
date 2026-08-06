/**
 * exit-forensics.ts — say why this process is going away, before it goes away.
 *
 * PolarProcess is restarted by launchd every 30–60s and nobody could say why: the job's
 * parent exits 143 (its child took a SIGTERM), the next start.sh reclaims the orphan
 * listener, and the log shows only the reclaim — never the death. Every candidate we can
 * check from the outside has been ruled out (its own orphan scan never fires, it is not
 * registered as one of its own services, and the watchdog excludes authority projects),
 * so the remaining evidence has to come from inside: which signal arrived, and from what
 * parent, at what age.
 *
 * Installing a handler for a signal suppresses the default termination, so each one
 * re-exits with the conventional 128+signal to keep the exit status the supervisor sees
 * unchanged.
 */

const WATCHED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const;
const SIGNAL_NUMBERS: Record<(typeof WATCHED_SIGNALS)[number], number> = {
  SIGTERM: 15,
  SIGINT: 2,
  SIGHUP: 1,
  SIGQUIT: 3,
};

export interface ExitForensicsHooks {
  /** Defaults to console.log — injectable so a test can capture the lines. */
  readonly log?: (line: string) => void;
  /** Defaults to process.exit — injectable so a test does not kill the runner. */
  readonly exit?: (code: number) => void;
  readonly onSignal?: (signal: string) => void;
}

function describe(): string {
  return `pid=${process.pid} ppid=${process.ppid} uptime=${process.uptime().toFixed(1)}s`;
}

/**
 * Log the boot identity and every route out of the process. Returns a teardown that
 * removes the listeners (tests, and anything that embeds the server).
 */
export function installExitForensics(hooks: ExitForensicsHooks = {}): () => void {
  const log = hooks.log ?? ((line: string) => console.log(line));
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  log(`[ExitForensics] boot ${describe()}`);

  const signalHandlers = WATCHED_SIGNALS.map((signal) => {
    const handler = () => {
      // ppid here is the live one: if launchd already reaped our parent it reads 1, which
      // distinguishes "our supervisor signalled us" from "we were orphaned then signalled".
      log(`[ExitForensics] received ${signal} — ${describe()}`);
      hooks.onSignal?.(signal);
      exit(128 + SIGNAL_NUMBERS[signal]);
    };
    process.on(signal, handler);
    return { signal, handler } as const;
  });

  const onUncaught = (error: unknown) => {
    log(`[ExitForensics] uncaughtException — ${describe()} — ${String(error)}`);
  };
  const onUnhandled = (reason: unknown) => {
    log(`[ExitForensics] unhandledRejection — ${describe()} — ${String(reason)}`);
  };
  const onBeforeExit = (code: number) => {
    // Reaching beforeExit means the event loop simply drained — no signal, no crash.
    log(`[ExitForensics] event loop empty, exiting ${code} — ${describe()}`);
  };
  const onExit = (code: number) => {
    log(`[ExitForensics] exit ${code} — ${describe()}`);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  process.on('beforeExit', onBeforeExit);
  process.on('exit', onExit);

  return () => {
    for (const { signal, handler } of signalHandlers) process.off(signal, handler);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    process.off('beforeExit', onBeforeExit);
    process.off('exit', onExit);
  };
}
