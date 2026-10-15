import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // No `transpilePackages` for the SDK. It now resolves through its published
  // `dist` output via the package `exports` map — the same path an external
  // consumer takes. Compiling it from source instead would hide a broken
  // `exports`/`dist` configuration until publish time, and would let web depend
  // on internals that the published package does not expose.
  //
  // `packages/sdk` must therefore be built before `next build`. The root
  // `build` script handles that ordering.
};
export default nextConfig;
