// Helpers PURI de conversie pentru serializarea XML oficială MF (NOTAFD / ordnt).
// Regulile sunt derivate din tipurile simple din `schemas/notafd_v0.xsd` (autoritative).
// Fără efecte secundare, fără I/O — doar transformări valoare → string conform XSD.
//
// IntPoz12SType (xs:integer 0…999999999999) = sume în LEI ÎNTREGI (NU bani; fără ×100;
// fără zecimale), rotunjire în sus.
// DateSType (dd.mm.yyyy), Str1 (bife "1"/""), CuiSType (CIF fără "RO"), StrN (maxLength).

const MAX_LEI = 999999999999n; // IntPoz12SType maxInclusive (lei întregi)

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
 * Convertește o sumă RON la string-ul canonic xs:integer în LEI ÎNTREGI, potrivit pentru
 * IntPoz12SType (schema oficială MF e xs:integer — FĂRĂ zecimale). Rotunjire în SUS (ceiling):
 * orice fracție de leu urcă la leul următor (decizie Mircea).
 *   ronToLeiXml(5000)            -> "5000"
 *   ronToLeiXml(2964.5)          -> "2965"   (ceiling)
 *   ronToLeiXml("11.523.668,69") -> "11523669"
 *   ronToLeiXml("") | null|undef -> null     (apelantul OMITE atributul)
 *   ronToLeiXml(0)               -> "0"
 * Rotunjim la bani-cents întâi (Math.round(n*100)) ca să evităm artefacte de float ÎNAINTE de
 * ceiling (ex. 2964.00 să nu devină 2965 dintr-un 2964.0000001). Semnul e păstrat; schema
 * respinge negativele la validare (minInclusive 0). Aruncă pe input nenumeric sau > MAX_LEI.
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
  const cents = Math.round(n * 100);       // exact la ban, fără artefacte float
  let lei = Math.ceil(cents / 100);        // rotunjire în SUS la leu
  if (Object.is(lei, -0)) lei = 0;
  if (BigInt(Math.abs(lei)) > MAX_LEI)
    throw new Error(`ronToLeiXml: depășește intervalul IntPoz12 (max ${MAX_LEI} lei): ${val}`);
  return String(lei);
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
