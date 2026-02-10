/**
 * Structured logger for easy-chr using pino.
 *
 * Provides JSON-structured logging for SigNoz ingestion with child logger
 * support for correlation IDs (chrId, userId, stage).
 *
 * DEFENSIVE: If pino is unavailable, falls back to console-based logging.
 * Logger creation must NEVER crash the workflow.
 */

import type { Logger as PinoLogger } from 'pino';

let _rootLogger: PinoLogger | null = null;
let _pinoAvailable = false;

/**
 * Initialize the root logger. Call once at startup.
 * Safe to call multiple times (idempotent).
 */
function initLogger(): PinoLogger | null {
  if (_rootLogger) return _rootLogger;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pino = require('pino');

    const isDev = (process.env.NODE_ENV ?? 'development') === 'development';
    const level = process.env.LOG_LEVEL ?? 'info';

    const options: Record<string, unknown> = {
      level,
      base: { service: 'easy-chr' },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        level: (label: string) => ({ level: label.toUpperCase() }),
      },
    };

    // Use pino-pretty in development for readable output
    if (isDev) {
      try {
        options.transport = {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        };
      } catch {
        // pino-pretty not available in dev — use JSON
        console.warn('[logger] pino-pretty not found, using JSON output in development.');
      }
    }

    _rootLogger = pino.default ? pino.default(options) : pino(options);
    _pinoAvailable = true;
    return _rootLogger;
  } catch (err) {
    // pino not available — fall through to console fallback
    console.warn(`[logger] pino not available, using console fallback: ${err instanceof Error ? err.message : String(err)}`);
    _pinoAvailable = false;
    return null;
  }
}

/**
 * Console-based fallback logger that matches the pino interface.
 * Used when pino is not available.
 */
const consoleFallback = {
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  debug: (...args: unknown[]) => console.debug('[DEBUG]', ...args),
  fatal: (...args: unknown[]) => console.error('[FATAL]', ...args),
  trace: (...args: unknown[]) => console.debug('[TRACE]', ...args),
  child: (bindings: Record<string, unknown>) => {
    // Return a new fallback that prefixes bindings
    const prefix = Object.entries(bindings)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return {
      info: (...args: unknown[]) => console.log(`[INFO] [${prefix}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[WARN] [${prefix}]`, ...args),
      error: (...args: unknown[]) => console.error(`[ERROR] [${prefix}]`, ...args),
      debug: (...args: unknown[]) => console.debug(`[DEBUG] [${prefix}]`, ...args),
      fatal: (...args: unknown[]) => console.error(`[FATAL] [${prefix}]`, ...args),
      trace: (...args: unknown[]) => console.debug(`[TRACE] [${prefix}]`, ...args),
      child: (moreBindings: Record<string, unknown>) =>
        consoleFallback.child({ ...bindings, ...moreBindings }),
    };
  },
};

export type AppLogger = typeof consoleFallback;

/**
 * Get the root logger. Always returns a usable logger object.
 *
 * DEFENSIVE: Never returns null. Falls back to console-based logger.
 */
export function getLogger(): AppLogger {
  try {
    const pinoLogger = initLogger();
    if (pinoLogger) return pinoLogger as unknown as AppLogger;
  } catch {
    // Fall through to console fallback
  }
  return consoleFallback;
}

/**
 * Create a child logger with correlation context.
 *
 * Usage:
 *   const log = createChildLogger({ chrId: '123', userId: '456', stage: 'analyzing' });
 *   log.info('Processing started');
 */
export function createChildLogger(context: {
  chrId?: string;
  userId?: string;
  reportId?: string;
  stage?: string;
}): AppLogger {
  try {
    const root = getLogger();
    const bindings: Record<string, string> = {};
    if (context.chrId) bindings.chr_id = context.chrId;
    if (context.userId) bindings.user_id = context.userId;
    if (context.reportId) bindings.report_id = context.reportId;
    if (context.stage) bindings.stage = context.stage;
    return root.child(bindings) as AppLogger;
  } catch {
    return consoleFallback;
  }
}
