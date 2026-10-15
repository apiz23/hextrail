/**
 * Stub for the `server-only` marker package.
 *
 * Next.js resolves `server-only` at build time and fails the build if a client
 * component imports a module that uses it. The package is not installed as a
 * real dependency, so unit tests importing server modules alias to this file.
 *
 * This does NOT weaken the production guard: Next.js still enforces the real
 * package at build time.
 */
export {};
