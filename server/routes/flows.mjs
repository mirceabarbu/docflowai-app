// ── Test compatibility shim ─────────────────────────────────────────────────
// flows.mjs a fost redenumit in flows.legacy.mjs (ARCH-01).
// Routerul activ este server/routes/flows/index.mjs
// Acest shim este doar pentru compatibilitate cu testele existente.
export { default, injectFlowDeps } from './flows/index.mjs';
