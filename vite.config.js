// cacheDir resolves against the project root, so every lane gets its own.
// It must NOT live under node_modules: lane.sh symlinks that to canonical, so
// the default node_modules/.vite made all lanes share one dependency cache.
// Two lane servers optimising into it concurrently returned NaN through the
// whole rig — in both the test and its control, which is how it disguises
// itself as a real finding.
export default {
  cacheDir: '.vite-cache',
  server: { port: 5810, strictPort: true, host: true },
  preview: { port: 5811, strictPort: true, host: true,
           // Railway's public domain is not localhost; vite preview 403s
           // unknown Host headers unless they are allowed explicitly.
           allowedHosts: ['.up.railway.app'] },
};
