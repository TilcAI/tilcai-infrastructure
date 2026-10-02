/** Minimal structured logger for worker/CLI. Never pass secrets in `fields`. */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(name: string, level: string = "info"): Logger {
  const min = order[(level in order ? level : "info") as Level];
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, name, msg, ...fields }, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
