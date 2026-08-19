// #128b — fundația ORD multi-bloc (multi-furnizor / multi-cont).
//
// Coloanele plate `beneficiar` / `cif_beneficiar` / `iban_beneficiar` / `banca_beneficiar` /
// `documente_justificative` / `inf_pv_plata` / `inf_pv_plata1` / `nr_unic_inreg` de pe
// `formulare_ord` devin, începând cu #128c, o OGLINDĂ derivată din blocul 1 — scrisă
// într-un singur loc (`oglindaBloc1`) și NICIODATĂ citită de vreo agregare sau potrivire.
// Sursa de adevăr e `blocuri[]`. Motivul: DocFlowAI a plătit deja de două ori pentru un adevăr
// ținut în două locuri (`orgId` coloană + JSONB pe `flows`; `df.flow_id` față de
// `alop.df_flow_id`, care a produs divergența din 12.08.2026). `opme-matcher.mjs` cheiază azi
// pe coloana plată `cif_beneficiar` — dacă rămâne acolo după ce apar blocuri multiple, potrivirea
// plăților se face pe furnizorul greșit, TĂCUT.
//
// Modul PUR: fără pool, fără import din rute, fără efecte secundare.

const BLOC_KEYS = [
  'nr_unic_inreg',
  'beneficiar',
  'documente_justificative',
  'iban_beneficiar',
  'cif_beneficiar',
  'banca_beneficiar',
  'inf_pv_plata',
  'inf_pv_plata1',
];

/**
 * #128l — `bloc_idx` normalizat: număr întreg ≥ 0, implicit 0.
 * Sursă UNICĂ pentru „cărui bloc îi aparține rândul ăsta" — folosită atât la SCRIERE
 * (`pregatesteScriereBlocuri`) cât și de garda `rows_bloc_lipsa` din `/complete`.
 * Dacă cele două ar diverge, un rând s-ar număra la gardă într-un bloc și s-ar scrie în
 * altul — exact clasa de bug de la #115 (potrivire la selecție, agregare pe altceva).
 * Acceptă și string numeric ('1'), fiindcă JSON-ul unui client vechi poate trimite așa.
 */
function normalizeBlocIdx(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * Întoarce array-ul de blocuri al unui ORD, normalizat, niciodată gol.
 * `ord.blocuri` NULL / [] / tip neașteptat => un singur bloc legacy (bloc_idx 0),
 * construit din coloanele plate ale ORD-ului.
 */
function blocuriDinOrd(ord) {
  const o = ord || {};
  if (Array.isArray(o.blocuri) && o.blocuri.length > 0) {
    return o.blocuri.map((b, idx) => ({
      ...b,
      bloc_idx: typeof b?.bloc_idx === 'number' ? b.bloc_idx : idx,
    }));
  }
  const legacy = { bloc_idx: 0 };
  for (const key of BLOC_KEYS) {
    legacy[key] = o[key] ?? '';
  }
  return [legacy];
}

/**
 * Rândurile din `rows` care aparțin blocului `blocIdx`.
 * Un rând fără `bloc_idx` (sau cu null/undefined) aparține blocului 0.
 */
function randuriBloc(rows, blocIdx) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => normalizeBlocIdx(r?.bloc_idx) === blocIdx);
}

/**
 * Distribuie `rows` pe `nrBlocuri` array-uri, indexat pe bloc.
 */
function randuriPeBlocuri(rows, nrBlocuri) {
  const result = [];
  for (let i = 0; i < nrBlocuri; i++) {
    result.push(randuriBloc(rows, i));
  }
  return result;
}

/**
 * Obiectul de coloane plate care trebuie scris ca oglindă a blocului 1 (index 0).
 */
function oglindaBloc1(blocuri) {
  const list = Array.isArray(blocuri) ? blocuri : [];
  const bloc1 = list.find((b) => b?.bloc_idx === 0) || list[0];
  const out = {};
  for (const key of BLOC_KEYS) {
    out[key] = bloc1?.[key] ?? '';
  }
  return out;
}

/**
 * #128c — pregătește SCRIEREA unui ORD (POST create / PUT update).
 *
 * PURĂ: nu atinge DB-ul, nu mută input-urile.
 *
 * @param {object}  body        body-ul brut al cererii (poate conține `blocuri`)
 * @param {object}  data        câmpurile deja filtrate prin `pick(body, …_FIELDS)` și trecute
 *                              prin `normalizeAngajamentRows` + `deriveOrdIdentityCols`
 * @param {object?} docExistent rândul curent din DB (PUT); `null` la creare
 * @returns {{ blocuri: Array, oglinda: object, rows: Array|undefined }}
 *
 * `oglinda` = coloanele plate de scris. Conține DOAR cheile care trebuie efectiv scrise:
 * un câmp pe care nici payload-ul, nici documentul existent nu-l cunosc rămâne NEATINS
 * (altfel oglinda ar scrie '' peste NULL — o modificare de date deghizată în non-regresie).
 * Când clientul trimite `blocuri` explicit, oglinda acoperă toate cele 8 chei: blocul 1 e
 * atunci sursa completă de adevăr.
 */
function pregatesteScriereBlocuri({ body, data, docExistent = null }) {
  const b = body || {};
  const d = data || {};
  const prev = docExistent || null;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  let blocuri;
  let oglindaCompleta;
  if (Array.isArray(b.blocuri) && b.blocuri.length > 0) {
    blocuri = blocuriDinOrd({ blocuri: b.blocuri });
    oglindaCompleta = true;
  } else {
    // Un singur bloc, fuzionat: payload > document existent > necunoscut.
    // ⚠️ Fuziunea peste `docExistent` e miezul corectitudinii la PUT — clientul trimite
    // frecvent payload-uri PARȚIALE (doar `beneficiar`, doar `rows`).
    const bloc = { bloc_idx: 0 };
    for (const key of BLOC_KEYS) {
      if (has(d, key)) bloc[key] = d[key];
      else if (has(prev, key) && prev[key] !== null && prev[key] !== undefined) bloc[key] = prev[key];
      else bloc[key] = null;
    }
    blocuri = [bloc];
    oglindaCompleta = false;
  }

  const plate = oglindaBloc1(blocuri);
  const bloc1 = blocuri.find((x) => x?.bloc_idx === 0) || blocuri[0] || {};
  const oglinda = {};
  for (const key of BLOC_KEYS) {
    if (!oglindaCompleta && (bloc1[key] === null || bloc1[key] === undefined)) continue;
    oglinda[key] = plate[key];
  }

  // `bloc_idx` pe rânduri — se aplică DUPĂ normalizeAngajamentRows/deriveOrdIdentityCols
  // (constrângere de ordonare în rute: ambele reconstruiesc obiectele rândurilor).
  let rows;
  if (has(d, 'rows')) {
    rows = Array.isArray(d.rows)
      ? d.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r)
        ? { ...r, bloc_idx: normalizeBlocIdx(r.bloc_idx) }
        : r))
      : d.rows;
  }

  return { blocuri, oglinda, rows };
}

/**
 * #128d — profilul de POTRIVIRE al fiecărui bloc: cine e beneficiarul (cif + iban) și
 * ce triplete `cod||indicator` îi aparțin.
 *
 * PURĂ. Consumată de `opme-matcher.mjs`, care până la #128d citea `cif_beneficiar` /
 * `iban_beneficiar` ca pe niște coloane plate UNICE și lua tripletele din TOATE rândurile
 * ORD-ului — cu blocuri multiple asta potrivește plata pe furnizorul greșit, TĂCUT.
 *
 * Retrocompatibil prin construcție: un ORD legacy (`blocuri` NULL) dă exact UN profil,
 * derivat din coloanele plate, cu toate rândurile (fără `bloc_idx` ⇒ blocul 0).
 *
 * ⛔ Verdictul de IBAN NU se calculează aici — rămâne în `_ibanVerdict` din
 *    `opme-matcher.mjs`, un singur loc pentru ambele căi (selecție + agregare). Profilul
 *    livrează doar IBAN-ul brut (trimuit).
 *
 * Un profil fără `cif` sau cu `triplete` goale se întoarce ORICUM — filtrarea o face
 * apelantul, ca să poată raporta motivul.
 *
 * @param {object} ord  { blocuri?, rows?, + coloanele plate pentru fallback-ul legacy }
 * @returns {{ bloc_idx: number, cif: string, iban: string, triplete: Set<string> }[]}
 */
function profiluriBlocuri(ord) {
  const o = ord || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  return blocuriDinOrd(o).map((b) => {
    const triplete = new Set();
    for (const r of randuriBloc(rows, b.bloc_idx)) {
      const cod = String(r?.cod_angajament ?? '').trim();
      const ind = String(r?.indicator_angajament ?? '').trim();
      if (cod && ind) triplete.add(`${cod}||${ind}`);
    }
    return {
      bloc_idx: b.bloc_idx,
      cif: String(b?.cif_beneficiar ?? '').trim(),
      iban: String(b?.iban_beneficiar ?? '').trim(),
      triplete,
    };
  });
}

export { blocuriDinOrd, randuriBloc, randuriPeBlocuri, oglindaBloc1, pregatesteScriereBlocuri,
         profiluriBlocuri, normalizeBlocIdx };
