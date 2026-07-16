// Helpers PURI de conversie pentru serializarea XML oficială MF (NOTAFD / ordnt).
// Regulile sunt derivate din tipurile simple din `schemas/notafd_v0.xsd` (autoritative).
// Fără efecte secundare, fără I/O — doar transformări valoare → string conform XSD.
//
// IntPoz12SType (xs:decimal 0…999999999999.99, 2 zecimale) = sume în LEI (NU bani; fără ×100).
// DateSType (dd.mm.yyyy), Str1 (bife "1"/""), CuiSType (CIF fără "RO"), StrN (maxLength).

const MAX_LEI_CENTS = 99999999999999n; // 999999999999.99 lei, în bani-cents (IntPoz12SType maxInclusive)

/**
 * Parsează un număr scris fie ca decimal JS ("11523668.69" / 11523668.69 — formatul
 * stocat real în DocFlowAI, consumat de PDF prin parseFloat), fie în format românesc
 * ("11.523.668,69" — separator mii ".", zecimal ","). Întoarce un Number.
 */
function parseAmount(s) {
  s = String(s).replace(/[\s ]/g, '');
  if (s.includes(',')) {
    // Format românesc: "." = mii, "," = zecimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Fără virgulă: mai multe puncte = grupare mii (românesc fără zecimale);
    // un singur punct (sau niciunul) = decimal JS / întreg (date reale stocate).
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`ronToLeiXml: valoare nenumerică: "${s}"`);
  return n;
}

/**
 * Convertește o sumă RON la string-ul canonic xs:decimal în LEI, cu exact 2 zecimale
 * (separator "."), potrivit pentru IntPoz12SType. NU mai înmulțește cu 100 — formularul
 * MF interpretează numărul ca lei.
 *   ronToLeiXml(11523668.69)        -> "11523668.69"
 *   ronToLeiXml("11.523.668,69")    -> "11523668.69"
 *   ronToLeiXml(2964.5)             -> "2964.50"
 *   ronToLeiXml("") | null | undef  -> null  (apelantul OMITE atributul)
 *   ronToLeiXml(0)                  -> "0.00" (valoare completată = 0)
 * Aritmetică pe bani-cents (întregi) ca să nu apară artefacte de float (ex. "2964.5000001").
 * Păstrează semnul — influențele negative din revizii NU se clampază/abs (ar corupe
 * datele financiare); schema le respinge la validare (minInclusive 0).
 * Aruncă pe input nenumeric sau magnitudine > 999999999999.99 lei.
 */
export function ronToLeiXml(val) {
  if (val === null || val === undefined) return null;
  let n;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error(`ronToLeiXml: valoare nefinită: ${val}`);
    n = val;
  } else {
    const s = String(val).trim();
    if (s === '') return null;
    n = parseAmount(s);
  }
  let cents = Math.round(n * 100);
  if (Object.is(cents, -0)) cents = 0;
  if (BigInt(Math.abs(cents)) > MAX_LEI_CENTS)
    throw new Error(`ronToLeiXml: depășește intervalul IntPoz12 (max 999999999999.99 lei): ${val}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const lei = Math.floor(abs / 100);
  const bani = abs % 100;
  return `${sign}${lei}.${String(bani).padStart(2, '0')}`;
}

/**
 * Normalizează o dată la formatul DateSType (dd.mm.yyyy, zero-padding opțional).
 * Acceptă: string deja "d.m.yyyy" (pass-through), ISO "yyyy-mm-dd", sau Date.
 * Întoarce null pentru valoare lipsă/empty.
 */
export function dateRo(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return `${val.getDate()}.${val.getMonth() + 1}.${val.getFullYear()}`;
  }
  const s = String(val).trim();
  if (s === '') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${Number(iso[3])}.${Number(iso[2])}.${iso[1]}`;
  return s; // presupunem deja dd.mm.yyyy (validat la persistare)
}

/**
 * Bifă (Str1): bifat -> "1", nebifat -> "". Oglindește `isChecked` din formulare.mjs.
 */
export function ckbx(v) {
  return (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? '1' : '';
}

/**
 * CIF pentru CuiSType ([1-9]\d{1,9}): elimină prefixul "RO" și spațiile. NU adaugă
 * și NU elimină zerouri (ar schimba valoarea) — datele sunt deja validate la persistare.
 */
export function cif(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/^RO/i, '').replace(/[\s ]/g, '');
}

/**
 * Escape XML pentru valori de atribute (& < > " ').
 */
export function xmlEscape(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validează lungimea conform maxLength din XSD. NU trunchiază silențios (ar corupe
 * date financiare/oficiale) — aruncă eroare descriptivă dacă depășește.
 */
export function strClamp(val, max, fieldName) {
  const s = String(val ?? '');
  if (s.length > max)
    throw new Error(`strClamp: câmpul "${fieldName}" depășește maxLength ${max} (are ${s.length})`);
  return s;
}
