const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const levelName = process.env.LOG_LEVEL?.toLowerCase() ?? "info";
const threshold = LEVELS[levelName] ?? LEVELS.info;

const select =
  (method, fallback = method) =>
    (...args) => {
      const levelKey = method === "log" ? "info" : method;
      if (threshold >= LEVELS[levelKey]) {
        (console[method] ?? console[fallback])(...args);
      }
    };

export const logger = {
  error: select("error"),
  warn: select("warn"),
  info: select("log"),
  debug: select("debug", "log")
};

export default logger;
