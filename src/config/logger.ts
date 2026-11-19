import pino, { type Logger } from "pino";
import pinoPretty from "pino-pretty";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").trim().toLowerCase();
const LOG_FORMAT = (process.env.LOG_FORMAT || "pretty").trim().toLowerCase();

function createRootLogger(): Logger {
  const baseOptions: pino.LoggerOptions = {
    level: LOG_LEVEL,
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "headers.Authorization",
        "password",
        "*.password",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (LOG_FORMAT === "json") {
    return pino(baseOptions);
  }

  // Synchronous pretty stream (no worker_threads) so `bun build --compile` works cleanly
  const prettyStream = pinoPretty({
    colorize: process.stdout.isTTY !== false,
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
    ignore: "pid,hostname,module",
    messageFormat: (log, messageKey) => {
      const mod = typeof log.module === "string" ? `[${log.module}] ` : "";
      const msg = log[messageKey] ?? "";
      return `${mod}${String(msg)}`;
    },
    singleLine: false,
  });

  return pino(baseOptions, prettyStream);
}

export const logger: Logger = createRootLogger();

export function createLogger(module: string): Logger {
  return logger.child({ module });
}

export function getLogConfigSummary(): { level: string; format: string } {
  return {
    level: LOG_LEVEL,
    format: LOG_FORMAT,
  };
}
