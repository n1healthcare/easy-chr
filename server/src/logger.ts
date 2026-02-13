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
import { sanitizeLogMessage, sanitizeObjectValues } from './utils/pii-sanitizer.js';

let _rootLogger: PinoLogger | null = null;
let _pinoAvailable = false;
let _consoleBridgeInstalled = false;

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
      hooks: {
        // Sanitize PII from log messages and objects before serialization
        logMethod(
          this: PinoLogger,
          inputArgs: [Record<string, unknown> | string, ...unknown[]],
          method: (...args: unknown[]) => void,
        ) {
          // pino calling convention: (msg), (obj, msg), (obj, msg, ...interpolation)
          if (inputArgs.length > 0 && inputArgs[0] instanceof Error) {
            const error = inputArgs[0];
            inputArgs[0] = {
              error: {
                name: error.name,
                message: sanitizeLogMessage(error.message),
                stack: error.stack,
              },
            };
            if (inputArgs.length > 1 && typeof inputArgs[1] === 'string') {
              inputArgs[1] = sanitizeLogMessage(inputArgs[1] as string);
            }
          } else if (inputArgs.length > 0 && typeof inputArgs[0] === 'string') {
            inputArgs[0] = sanitizeLogMessage(inputArgs[0]);
          } else if (inputArgs.length > 0 && typeof inputArgs[0] === 'object' && inputArgs[0] !== null) {
            inputArgs[0] = sanitizeObjectValues(inputArgs[0] as Record<string, unknown>);
            if (inputArgs.length > 1 && typeof inputArgs[1] === 'string') {
              inputArgs[1] = sanitizeLogMessage(inputArgs[1] as string);
            }
          }
          method.apply(this, inputArgs as unknown[]);
        },
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
 * Sanitize string arguments for PII before passing to console methods.
 */
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string') return sanitizeLogMessage(arg);
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      return sanitizeObjectValues(arg as Record<string, unknown>);
    }
    return arg;
  });
}

/**
 * Console-based fallback logger that matches the pino interface.
 * Used when pino is not available. Includes PII sanitization.
 */
const consoleFallback = {
  info: (...args: unknown[]) => console.log('[INFO]', ...sanitizeArgs(args)),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...sanitizeArgs(args)),
  error: (...args: unknown[]) => console.error('[ERROR]', ...sanitizeArgs(args)),
  debug: (...args: unknown[]) => console.debug('[DEBUG]', ...sanitizeArgs(args)),
  fatal: (...args: unknown[]) => console.error('[FATAL]', ...sanitizeArgs(args)),
  trace: (...args: unknown[]) => console.debug('[TRACE]', ...sanitizeArgs(args)),
  child: (bindings: Record<string, unknown>) => {
    // Return a new fallback that prefixes bindings
    const prefix = Object.entries(bindings)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return {
      info: (...args: unknown[]) => console.log(`[INFO] [${prefix}]`, ...sanitizeArgs(args)),
      warn: (...args: unknown[]) => console.warn(`[WARN] [${prefix}]`, ...sanitizeArgs(args)),
      error: (...args: unknown[]) => console.error(`[ERROR] [${prefix}]`, ...sanitizeArgs(args)),
      debug: (...args: unknown[]) => console.debug(`[DEBUG] [${prefix}]`, ...sanitizeArgs(args)),
      fatal: (...args: unknown[]) => console.error(`[FATAL] [${prefix}]`, ...sanitizeArgs(args)),
      trace: (...args: unknown[]) => console.debug(`[TRACE] [${prefix}]`, ...sanitizeArgs(args)),
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

function normalizeConsoleArgs(args: unknown[]): [Record<string, unknown> | undefined, string] {
  if (args.length === 0) return [undefined, ''];
  const first = args[0];
  if (first instanceof Error) {
    return [
      {
        error: {
          name: first.name,
          message: sanitizeLogMessage(first.message),
          stack: first.stack,
        },
      },
      args.slice(1).map((arg) => (typeof arg === 'string' ? sanitizeLogMessage(arg) : String(arg))).join(' '),
    ];
  }
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const obj = sanitizeObjectValues(first as Record<string, unknown>);
    const msg = args.slice(1).map((arg) => (typeof arg === 'string' ? sanitizeLogMessage(arg) : String(arg))).join(' ');
    return [obj, msg];
  }
  return [
    undefined,
    args.map((arg) => (typeof arg === 'string' ? sanitizeLogMessage(arg) : String(arg))).join(' '),
  ];
}

/**
 * Redirect console.* calls to the structured logger when pino is available.
 * This improves production traceability for legacy console logging paths.
 */
export function installConsoleBridge(logger: AppLogger = getLogger()): void {
  if (_consoleBridgeInstalled || !_pinoAvailable) return;
  _consoleBridgeInstalled = true;

  const createBridge = (
    level: 'info' | 'warn' | 'error' | 'debug',
    fallbackName: string,
  ) => (...args: unknown[]) => {
    const [obj, msg] = normalizeConsoleArgs(args);
    if (obj) {
      logger[level](obj, msg || fallbackName);
    } else {
      logger[level](msg || fallbackName);
    }
  };

  console.log = createBridge('info', 'console.log');
  console.info = createBridge('info', 'console.info');
  console.warn = createBridge('warn', 'console.warn');
  console.error = createBridge('error', 'console.error');
  console.debug = createBridge('debug', 'console.debug');
}
