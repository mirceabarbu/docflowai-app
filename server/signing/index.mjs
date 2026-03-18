/**
 * DocFlowAI — Signing Factory
 *
 * Arhitectură corectă:
 *   - org.signing_providers_enabled[]  → ce provideri sunt contractați în org
 *   - org.signing_providers_config{}   → config per provider (API keys etc.)
 *   - signer.signingProvider           → ce a ales semnatarul la momentul semnării
 *
 * Usage:
 *   import { getProvider, getOrgProviders, getOrgProviderConfig } from './signing/index.mjs';
 *   const provider = getProvider('certsign');
 *   const config   = getOrgProviderConfig(org, 'certsign');
 *   const session  = await provider.initiateSession({ ..., config });
 */

import { LocalUploadProvider }  from './providers/LocalUploadProvider.mjs';
import { STSCloudProvider }     from './providers/STSCloudProvider.mjs';
import { CertSignProvider }     from './providers/CertSignProvider.mjs';
import { TransSpedProvider }    from './providers/TransSpedProvider.mjs';
import { AlfaTrustProvider }    from './providers/AlfaTrustProvider.mjs';
import { NamirialProvider }     from './providers/NamirialProvider.mjs';

// ── Registry complet ───────────────────────────────────────────────────────
// Adaugă noi provideri DOAR AICI — restul aplicației nu se schimbă.
const ALL_PROVIDERS = [
  new LocalUploadProvider(),
  new STSCloudProvider(),
  new CertSignProvider(),
  new TransSpedProvider(),
  new AlfaTrustProvider(),
  new NamirialProvider(),
  // new EUDIWalletProvider(), // eIDAS 2.0 — viitor 2027
];

const PROVIDER_MAP = new Map(ALL_PROVIDERS.map(p => [p.id, p]));

/**
 * Returnează provider-ul cu ID-ul dat.
 * Fallback SIGUR la 'local-upload' dacă ID-ul nu există.
 * @param {string} id
 * @returns {import('./SigningProvider.mjs').SigningProvider}
 */
export function getProvider(id) {
  const p = PROVIDER_MAP.get(id);
  if (!p) {
    console.warn(`[signing] Provider necunoscut: "${id}" — fallback la local-upload`);
    return PROVIDER_MAP.get('local-upload');
  }
  return p;
}

/**
 * Lista TUTUROR provideri disponibili în platformă (pentru UI admin — secțiunea provideri).
 * @returns {Array<{id, label, mode, available}>}
 */
export function listAllProviders() {
  return ALL_PROVIDERS.map(p => ({
    id:        p.id,
    label:     p.label,
    mode:      p.mode,
    available: true,
  }));
}

/**
 * Lista provideri ACTIVI pentru o organizație.
 * Aceștia apar în dropdown-ul de selecție al semnatarului.
 *
 * @param {object} org — rândul din tabelul organizations
 * @returns {Array<{id, label, mode}>}
 */
export function getOrgProviders(org) {
  const enabled = Array.isArray(org?.signing_providers_enabled)
    ? org.signing_providers_enabled
    : ['local-upload']; // fallback sigur

  return enabled
    .map(id => PROVIDER_MAP.get(id))
    .filter(Boolean)
    .map(p => ({ id: p.id, label: p.label, mode: p.mode }));
}

/**
 * Returnează configurația unui provider specific din org.
 * @param {object} org        — rândul din organizations
 * @param {string} providerId
 * @returns {object}          — ex: { apiKey: '...', apiUrl: '...', webhookSecret: '...' }
 */
export function getOrgProviderConfig(org, providerId) {
  const config = org?.signing_providers_config;
  if (!config || typeof config !== 'object') return {};
  return config[providerId] || {};
}

/**
 * Returnează provider-ul configurat pentru o organizație.
 * Dacă org nu are provideri configurați, returnează local-upload.
 * @param {object} org
 * @param {string} [preferredId] — override (ales de semnatar)
 * @returns {import('./SigningProvider.mjs').SigningProvider}
 */
export function getOrgProvider(org, preferredId = null) {
  const enabled = Array.isArray(org?.signing_providers_enabled)
    ? org.signing_providers_enabled
    : ['local-upload'];

  const id = (preferredId && enabled.includes(preferredId))
    ? preferredId
    : (enabled[0] || 'local-upload');

  return getProvider(id);
}
