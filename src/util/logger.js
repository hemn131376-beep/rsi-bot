const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

function fmt(level, scope, args) {
  return [`[${ts()}]`, level, scope ? `(${scope})` : '', ...args];
}

export function makeLogger(scope = '') {
  return {
    info: (...a) => console.log(...fmt('INFO ', scope, a)),
    warn: (...a) => console.warn(...fmt('WARN ', scope, a)),
    error: (...a) => console.error(...fmt('ERROR', scope, a)),
    debug: (...a) => {
      if (process.env.DEBUG === '1') console.log(...fmt('DEBUG', scope, a));
    },
  };
}

export const log = makeLogger();
