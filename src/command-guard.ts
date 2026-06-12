/**
 * command-guard.ts — Shell command injection prevention
 *
 * Validates and sanitizes commands before they are passed to spawn/exec.
 * Strategy: allowlist of known task_type → command patterns, plus
 * general rejection of shell metacharacters in dynamic segments.
 */

import path from 'node:path';

const POLARISOR_ROOT = path.join(process.env.HOME ?? '~', 'Polarisor');

const DANGEROUS_PATTERNS = [
  /;/,              // semicolon chaining
  /\|(?!\|)/,       // pipe (but allow ||)
  /(?<![&])&(?!&)/, // single & (background) but allow &&
  /`/,              // backtick substitution
  /\$\(/,           // command substitution $(...)
  /\$\{/,           // variable expansion ${...}
  />\s*\//,         // redirect to absolute path
  /\.\.\//,         // path traversal
  /[\n\r]/,         // newlines (multi-statement injection)
];

/**
 * Validate that a command string doesn't contain obvious injection vectors.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function validateCommand(command: string): { ok: boolean; reason?: string } {
  if (!command || command.trim().length === 0) {
    return { ok: false, reason: 'empty command' };
  }

  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(command)) {
      return { ok: false, reason: `blocked pattern: ${pat.source}` };
    }
  }

  return { ok: true };
}

/**
 * Validate that a path is under ~/Polarisor (or ~/.sotagent).
 * Prevents directory traversal to sensitive system paths.
 */
export function validatePath(p: string): { ok: boolean; reason?: string } {
  const resolved = path.resolve(p);
  const home = process.env.HOME ?? '/';
  const allowedRoots = [
    path.join(home, 'Polarisor'),
    path.join(home, '.sotagent'),
  ];

  if (allowedRoots.some(root => resolved.startsWith(root + path.sep) || resolved === root)) {
    return { ok: true };
  }

  return { ok: false, reason: `path ${resolved} is outside allowed roots (${allowedRoots.join(', ')})` };
}

/**
 * Shell-escape a single argument for safe interpolation into a shell string.
 * Wraps in single quotes with internal quote escaping.
 */
export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Normalize a service command: strip `cd DIR &&` prefix and extract work_dir.
 *
 * Many self-registering services use `cd /some/path && python3 foo.py`,
 * but process-manager already passes `cwd` to spawn. This function
 * canonicalizes the command so it passes validateCommand() cleanly.
 *
 * Also strips leading `VAR=val` env-var assignments when they duplicate
 * what the caller already provides through the environment.
 *
 * Returns { command, work_dir? } where work_dir is set only when a cd
 * prefix was extracted.
 */
export function normalizeCommand(
  command: string,
  existingWorkDir?: string,
): { command: string; work_dir?: string } {
  let cmd = command.trim();

  // Pattern: cd /some/path && rest-of-command
  // Captures quoted or unquoted paths, tolerates spaces around &&
  const cdPattern = /^cd\s+["']?([^"'&;]+?)["']?\s*&&\s*/;
  const match = cmd.match(cdPattern);

  if (match) {
    const extractedDir = match[1]!.trim();
    cmd = cmd.slice(match[0].length).trim();

    // Only propagate work_dir if the caller didn't already set one,
    // or if the extracted dir is different (more specific).
    const resolvedExtracted = extractedDir.replace(/^~/, process.env.HOME ?? '~');
    const resolvedExisting = existingWorkDir?.replace(/^~/, process.env.HOME ?? '~');

    if (!resolvedExisting || resolvedExisting !== resolvedExtracted) {
      return { command: cmd, work_dir: extractedDir };
    }
    return { command: cmd };
  }

  return { command: cmd };
}

/**
 * Validate a KnowLever topic name — alphanumeric + hyphens + underscores only.
 */
export function validateTopicName(name: string): { ok: boolean; reason?: string } {
  if (/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(name)) {
    return { ok: true };
  }
  return { ok: false, reason: `invalid topic name: ${name}` };
}
