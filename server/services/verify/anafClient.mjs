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

export function parseAnafRecord(rec) {
  if (!rec) return null;
  const dg    = rec.date_generale || {};
  const tva   = rec.inregistrare_scop_Tva || {};
  const tvaI  = rec.inregistrare_RTVAI || {};
  const inact = rec.stare_inactiv || {};
  const split = rec.inregistrare_SplitTVA || {};
  const sediu = rec.adresa_sediu_social || {};
  const domic = rec.adresa_domiciliu_fiscal || {};

  // Județ: preferă sediu_social, fallback domiciliu_fiscal
  const county     = sediu.sdenumire_Judet      || domic.ddenumire_Judet      || '';
  const countyCode = sediu.scod_Judet           || domic.dcod_Judet           || '';
  const countyAuto = sediu.scod_JudetAuto       || domic.dcod_JudetAuto       || '';
  const locality   = sediu.sdenumire_Localitate || domic.ddenumire_Localitate || '';

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
  if (sediu.sdenumire_Strada || sediu.snumar_Strada || sediu.sdenumire_Localitate) {
    const parts = [];
    if (sediu.sdenumire_Strada) parts.push(sediu.sdenumire_Strada + (sediu.snumar_Strada ? ' ' + sediu.snumar_Strada : ''));
    if (sediu.sdetalii_Adresa)  parts.push(sediu.sdetalii_Adresa);
    if (sediu.sdenumire_Localitate) parts.push(sediu.sdenumire_Localitate);
    if (sediu.sdenumire_Judet) parts.push('jud. ' + sediu.sdenumire_Judet);
    cleanAddress = parts.join(', ');
  }

  return {
    // Date generale
    cui: String(dg.cui || ''),
    name: dg.denumire || '',
    address: cleanAddress || dg.adresa || '',
    county,
    countyCode,
    countyAuto,
    locality,
    postalCode: sediu.scod_Postal || dg.codPostal || '',
    phone: dg.telefon || '',
    fax: dg.fax || '',
    registrationDate: dg.data_inregistrare || null,
    registrationStatus: dg.stare_inregistrare || '',
    legalForm:        dg.forma_juridica      || '',
    organizationForm: dg.forma_organizare    || '',
    ownershipForm:    dg.forma_de_proprietate || '',
    entityType,
    tradeRegisterNo:  dg.nrRegCom  || '',
    caenCode:         dg.cod_CAEN  || '',
    fiscalAuthority:  dg.organFiscalCompetent || '',
    authorizationAct: dg.act       || '',
    anafIban:         dg.iban      || '',

    // TVA — scop
    vat: tva.scpTVA === true,
    vatStartDate:    (tva.perioade_TVA && tva.perioade_TVA.data_inceput_ScpTVA) || null,
    vatEndDate:      tva.data_sfarsit_ScpTVA   || null,
    vatCancelDate:   tva.data_anul_imp_ScpTVA  || null,
    vatCancelReason: tva.mesaj_ScpTVA          || '',

    // TVA la încasare
    vatCollected:          tvaI.statusTvaIncasare === true,
    vatCollectedStartDate: tvaI.dataInceputTvaInc || null,
    vatCollectedEndDate:   tvaI.dataSfarsitTvaInc || null,

    // Inactiv / radiat — CRITIC pentru plăți
    // Detectare multi-sursă: dataRadiere (ISO) SAU stare_inregistrare text liber
    // ANAF folosește: RADIAT, RADIATĂ, RADIATA, RADIERE, RADIERII — regex acoperă toate formele
    inactive:         inact.statusInactivi === true,
    inactiveDate:     inact.dataInactivare || null,
    reactivationDate: inact.dataReactivare || null,
    liquidationDate:  (() => {
      if (inact.dataRadiere) return inact.dataRadiere;
      const stare = String(dg.stare_inregistrare || '');
      const m = stare.match(/din data\s+(\d{2}\.\d{2}\.\d{4})/i);
      return (/\bRADI[AE][TR]/i.test(stare) && m) ? m[1] : null;
    })(),
    radiated: !!(inact.dataRadiere) || /\bRADI[AE][TR]/i.test(String(dg.stare_inregistrare || '')),
    stareInregistrareText: String(dg.stare_inregistrare || ''),

    // Split TVA
    splitVat:          split.statusSplitTVA === true,
    splitVatStartDate: split.dataInceputSplitTVA || null,

    // e-Factura
    eFactura: dg.statusRO_e_Factura === true,

    // Record brut pentru secțiunea 'Date complete ANAF' din UI
    _raw: rec,
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
  // Folosim data de ieri — ANAF publică date noaptea; data curentă dimineața poate lipsi din DB
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const queryDate = yesterday;
  const body = JSON.stringify([{ cui: Number(cui), data: queryDate }]);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(ANAF_URL, {
      method: 'POST',
      headers: {
        // Headere realiste pentru a trece WAF-ul ANAF (UA de tip node/undici e blocat)
        'User-Agent': 'Mozilla/5.0 (compatible; DocFlowAI/1.0; +https://www.docflowai.ro)',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'Content-Type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const rawText = await r.text().catch(() => '');
      console.error('[ANAF] HTTP non-OK status', r.status, 'body:', rawText.slice(0, 300));
      return { ok: false, reason: 'upstream_status_' + r.status };
    }

    // Parse defensiv — dacă WAF trimite HTML, r.json() ar eșua silent
    const rawText = await r.text();
    let j;
    try {
      j = JSON.parse(rawText);
    } catch (parseErr) {
      const isWaf = /Request Rejected|support ID|Access Denied|<html/i.test(rawText);
      console.error('[ANAF] Non-JSON response',
        isWaf ? '(WAF rejection)' : '(unexpected)',
        'snippet:', rawText.slice(0, 300).replace(/\s+/g, ' '));
      return { ok: false, reason: isWaf ? 'upstream_waf_blocked' : 'upstream_invalid_response' };
    }

    // Schema reală ANAF v9: răspuns conține DOAR {found, notFound}. Câmpul "cod" NU există
    // (documentația oficială e învechită). Source of truth: found vs notFound arrays.
    const found = Array.isArray(j.found) ? j.found : [];
    const notFound = Array.isArray(j.notFound) ? j.notFound : [];

    if (found.length > 0) {
      const data = parseAnafRecord(found[0]);
      _cache.set(cui, { expiresAt: Date.now() + CACHE_TTL_MS, data });
      return { ok: true, cached: false, data };
    }

    if (notFound.includes(Number(cui)) || notFound.map(String).includes(String(cui))) {
      return { ok: true, data: null, notFound: true };
    }

    // Nici found nici notFound — răspuns neașteptat
    console.error('[ANAF] Răspuns fără found și fără notFound. Raw:', JSON.stringify(j).slice(0, 800));
    return { ok: false, reason: 'upstream_empty_response' };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { ok: false, reason: 'upstream_timeout' };
    console.error('[ANAF] Fetch error:', e.message || e.code || String(e));
    return { ok: false, reason: 'upstream_unavailable', err: e.message };
  }
}
