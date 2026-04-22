// server/services/verify/anafClient.mjs
// Client ANAF pentru verificare CUI (API v9 public, gratuit).
// URL: https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
// Documentație oficială: https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt
// Rate limit soft: ~1 req/sec. Cache in-memory 15 min per CUI.

const ANAF_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
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
  const dg    = rec.date_generale || {};
  const tva   = rec.inregistrare_scop_Tva || {};
  const tvaI  = rec.inregistrare_RTVAI || {};
  const inact = rec.stare_inactiv || {};
  const sediu = rec.adresa_sediu_social || {};
  const domic = rec.adresa_domiciliu_fiscal || {};

  const county   = sediu.sdenumire_Judet    || domic.ddenumire_Judet    || '';
  const locality = sediu.sdenumire_Localitate || domic.ddenumire_Localitate || '';

  const formaJuridica = String(dg.forma_juridica || '').toUpperCase();
  const name = String(dg.denumire || '').toUpperCase();
  let entityType = 'unknown';
  if (/RASPUNDERE LIMITATA|RĂSPUNDERE LIMITATĂ|S\.R\.L|\bSRL\b/.test(formaJuridica) || /\bSRL\b/.test(name)) entityType = 'SRL';
  else if (/PE ACTIUNI|PE ACȚIUNI|S\.A\.|\bSA\b/.test(formaJuridica) || /\bS\.A\.?\b/.test(name)) entityType = 'SA';
  else if (/PERSOANA FIZICA AUTORIZATA|PERSOANĂ FIZICĂ AUTORIZATĂ|\bPFA\b/.test(formaJuridica) || /\bPFA\b/.test(name)) entityType = 'PFA';
  else if (/INTREPRINDERE|ÎNTREPRINDERE|\bII\b|\bIF\b|SOCIETATE NUME COLECTIV|\bSNC\b/.test(formaJuridica)) entityType = 'PF_other';
  else if (/\b(PRIMARIA|PRIMĂRIA|CONSILIUL|MINISTERUL|DIRECTIA|DIRECȚIA|INSPECTORATUL|CASA|AGENTIA|AGENȚIA|AUTORITATEA|SPITALUL|COLEGIUL|LICEUL|UNIVERSITATEA|GRADINITA|GRĂDINIȚA|SCOALA|ȘCOALA|INSTITUTUL|INSTITUȚIA)\b/.test(name)) entityType = 'public';
  else if (/\b(ASOCIATIA|ASOCIAȚIA|FUNDATIA|FUNDAȚIA|ONG)\b/.test(name)) entityType = 'NGO';

  let cleanAddress = '';
  if (sediu.sdenumire_Strada || sediu.sdenumire_Localitate) {
    const parts = [];
    if (sediu.sdenumire_Strada) parts.push(sediu.sdenumire_Strada + (sediu.snumar_Strada ? ' ' + sediu.snumar_Strada : ''));
    if (sediu.sdetalii_Adresa) parts.push(sediu.sdetalii_Adresa);
    if (sediu.sdenumire_Localitate) parts.push(sediu.sdenumire_Localitate);
    if (sediu.sdenumire_Judet) parts.push('jud. ' + sediu.sdenumire_Judet);
    cleanAddress = parts.join(', ');
  }

  return {
    cui: String(dg.cui || ''),
    name: dg.denumire || '',
    address: cleanAddress || dg.adresa || '',
    county,
    locality,
    postalCode: sediu.scod_Postal || dg.codPostal || '',
    phone: dg.telefon || '',
    registrationDate: dg.data_inregistrare || null,
    registrationStatus: dg.stare_inregistrare || '',
    legalForm: dg.forma_juridica || '',
    organizationForm: dg.forma_organizare || '',
    ownershipForm: dg.forma_de_proprietate || '',
    entityType,
    tradeRegisterNo: dg.nrRegCom || '',
    caenCode: dg.cod_CAEN || '',
    anafIban: dg.iban || '',
    vat: tva.scpTVA === true,
    vatCollected: tvaI.statusTvaIncasare === true,
    splitVat: !!(rec.inregistrare_SplitTVA && rec.inregistrare_SplitTVA.statusSplitTVA),
    eFactura: dg.statusRO_e_Factura === true,
    inactive: inact.statusInactivi === true,
    inactiveDate: inact.dataInactivare || null,
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
