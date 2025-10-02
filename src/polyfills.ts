// src/polyfills.ts
// Asegura globals que usan librerías de Node en el browser
(function () {
  const g: any = globalThis as any;

  // 'global' alias (algunas libs lo referencian)
  if (!g.global) g.global = g;

  // 'process' minimal
  if (!g.process) g.process = {};
  if (!g.process.env) g.process.env = {};
  // valores comunes que algunas libs leen:
  if (g.process.browser === undefined) g.process.browser = true;
  if (g.process.versions === undefined) g.process.versions = {};
  if (g.process.version === undefined) g.process.version = '';
  // algunos checks pasan 'process.stderr' a funciones de color
  if (g.process.stderr === undefined) g.process.stderr = null;
})();
