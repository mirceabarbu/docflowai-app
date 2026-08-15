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
  return list.filter((r) => {
    const idx = r?.bloc_idx === null || r?.bloc_idx === undefined ? 0 : r.bloc_idx;
    return idx === blocIdx;
  });
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

export { blocuriDinOrd, randuriBloc, randuriPeBlocuri, oglindaBloc1 };
