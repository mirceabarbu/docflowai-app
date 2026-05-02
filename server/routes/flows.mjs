// ── Test compatibility shim ─────────────────────────────────────────────────
// [ARCH-01] flows.mjs original a fost modularizat în server/routes/flows/.
// Acest shim există DOAR pentru compatibilitate cu importurile din teste
// (server/tests/integration/flows.test.mjs etc.).
// Routerul real este server/routes/flows/index.mjs.
export { default, injectFlowDeps } from './flows/index.mjs';
