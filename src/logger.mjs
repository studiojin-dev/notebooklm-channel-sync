const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function timestamp() {
  return new Date().toISOString();
}

export function createLogger({ level = "info" } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(kind, message) {
    const prefix = `[${timestamp()}] ${kind.toUpperCase()}`;
    const line = `${prefix} ${message}`;
    if (kind === "error") {
      console.error(line);
      return;
    }
    console.log(line);
  }

  return {
    debug(message) {
      if (threshold <= LEVELS.debug) write("debug", message);
    },
    info(message) {
      if (threshold <= LEVELS.info) write("info", message);
    },
    warn(message) {
      if (threshold <= LEVELS.warn) write("warn", message);
    },
    error(message) {
      write("error", message);
    },
    success(message) {
      if (threshold <= LEVELS.info) write("info", `SUCCESS ${message}`);
    },
  };
}
