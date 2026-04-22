// server/services/verify/anafClient.mjs
// Client ANAF pentru verificare CUI (API v9 public, gratuit).
// URL: https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/ws/tva
// Rate limit soft: ~1 req/sec. Cache in-memory 15 min per CUI.

const ANAF_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/ws/tva';
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

// Cache: Map<cui, {expiresAt, data}>
const _cache = new Map();

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) if (v.expiresAt < now) _cache.delete(k);
}

function normalizeCui(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/^RO/, '').replace(/\s+/g, '');
  if (!/^\d{2,10}$/.test(s)) return null;
  return s;
}

function parseAnafRecord(rec) {
  if (!rec) return null;
  const dg = rec.date_generale || {};
  const tva = rec.inregistrare_scop_Tva || {};
  const tvaInc = rec.inregistrare_RTVAI || {};
  const inactiv = rec.stare_inactiv || {};
  const name = (dg.denumire || '').toUpperCase();
  let entityType = 'unknown';
  if (/\bSRL\b|\bS\.R\.L\.?/.test(name)) entityType = 'SRL';
  else if (/\bSA\b|\bS\.A\.?/.test(name)) entityType = 'SA';
  else if (/\bPFA\b/.test(name)) entityType = 'PFA';
  else if (/\bSNC\b|\bII\b|\bIF\b/.test(name)) entityType = 'PF_other';
  else if (/\b(PRIMARIA|PRIMĂRIA|CONSILIUL|MINISTERUL|DIRECTIA|DIRECȚIA|INSPECTORATUL|CASA|AGENTIA|AGENȚIA|AUTORITATEA|SPITALUL|COLEGIUL|LICEUL|UNIVERSITATEA|GRADINITA|GRĂDINIȚA|SCOALA|ȘCOALA)\b/.test(name)) entityType = 'public';
  else if (/\b(ASOCIATIA|ASOCIAȚIA|FUNDATIA|FUNDAȚIA|ONG)\b/.test(name)) entityType = 'NGO';
  return {
    cui: String(dg.cui || ''),
    name: dg.denumire || '',
    address: dg.adresa || '',
    county: dg.judet || '',
    postalCode: dg.cod_postal || '',
    phone: dg.telefon || '',
    registrationDate: dg.data_inregistrare || null,
    registrationStatus: dg.stare_inregistrare || '',
    entityType,
    vat: tva.scpTVA === true,
    vatCollected: tvaInc.statusTvaIncasare === true,
    inactive: inactiv.statusInactivi === true,
    inactiveDate: inactiv.dataInactivare || null,
  };
}

export async function lookupCui(rawCui) {
  const cui = normalizeCui(rawCui);
  if (!cui) return { ok: false, reason: 'cui_invalid_format' };

  cleanCache();
  const cached = _cache.get(cui);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, cached: true, data: cached.data };
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify([{ cui: Number(cui), data: today }]);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(ANAF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, reason: 'upstream_status_' + r.status };
    const j = await r.json();
    if (j.cod !== 200 && j.cod !== '200') return { ok: false, reason: 'upstream_error', upstream: j };
    const found = Array.isArray(j.found) ? j.found : [];
    if (!found.length) return { ok: true, data: null, notFound: true };
    const data = parseAnafRecord(found[0]);
    _cache.set(cui, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    return { ok: true, cached: false, data };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { ok: false, reason: 'upstream_timeout' };
    return { ok: false, reason: 'upstream_unavailable', err: e.message };
  }
}
