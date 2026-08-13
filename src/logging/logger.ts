import { redactSensitive } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (serialized: string) => void;

export interface StructuredLogger {
  log(level: LogLevel, message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export function createLogger(
  sink: LogSink = (serialized) => process.stderr.write(`${serialized}\n`),
  now: () => string = () => new Date().toISOString(),
): StructuredLogger {
  return {
    log(level, message, metadata = {}) {
      sink(
        JSON.stringify({
          timestamp: now(),
          level,
          message,
          metadata: redactSensitive(metadata),
        }),
      );
    },
  };
}
