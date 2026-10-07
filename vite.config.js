export default {
  base: './',
  server: { port: 5173, strictPort: true },
  // satellite.js тянет за собой WASM-сборку с воркерами; в формате по умолчанию (iife) она не собирается
  worker: { format: 'es' },
};
