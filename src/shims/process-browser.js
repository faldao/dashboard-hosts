// Un "process" compatible para el navegador
const proc = {
  env: {},
  browser: true,
  argv: [],
  version: '',
  versions: {},
  nextTick: (cb, ...args) => queueMicrotask(() => cb(...args)),
  stdout: { isTTY: false },
  stderr: { isTTY: false },
};

export default proc;
// Compatibilidad con importaciones con nombre (pocas libs lo esperan)
export const env = proc.env;
