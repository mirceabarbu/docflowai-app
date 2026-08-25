/**
 * #144 (P0-05) — evaluarea calificării unui certificat pe DOVADĂ, nu pe nume.
 *
 * De ce există: până la #144, ambele motoare de verificare decideau
 * „calificat" din `numeEmitentPotrivit || extensiaExistă`. Amândoi operanzii
 * sunt falsificabili — numele emitentului e un șir liber (un certificat
 * auto-semnat cu „STS" în CN trecea), iar extensia `1.3.6.1.5.5.7.1.3` poate fi
 * prezentă și GOALĂ. Aici se cere CONȚINUTUL: OID-urile definite de
 * ETSI EN 319 412-5 (qcStatements) și EN 319 411-2 (politici de certificare).
 *
 * ⛔ Numele QTSP-ului rămâne o ETICHETĂ de afișare. NU e niciodată dovadă și nu
 *    intră în nicio decizie booleană din fișierul ăsta.
 *
 * ⛔ Modul PUR: fără importuri, fără I/O, fără DB. Ambele motoare
 *    (`services/certificate-verify.mjs` și `verify.mjs`) consumă DE AICI —
 *    o singură definiție a calificării, nu două.
 */

export const QC_OID = {
  COMPLIANCE:   '0.4.0.1862.1.1',    // certificat calificat conform eIDAS
  SSCD:         '0.4.0.1862.1.4',    // cheia privată într-un QSCD
  PDS:          '0.4.0.1862.1.5',
  TYPE:         '0.4.0.1862.1.6',
  TYPE_ESIGN:   '0.4.0.1862.1.6.1',
  TYPE_ESEAL:   '0.4.0.1862.1.6.2',
  TYPE_WEB:     '0.4.0.1862.1.6.3',
  POLICY_QCP_N_QSCD: '0.4.0.194112.1.2',   // persoană fizică, cu QSCD
  POLICY_QCP_L_QSCD: '0.4.0.194112.1.3',   // persoană juridică (sigiliu), cu QSCD
  POLICY_QCP_N:      '0.4.0.194112.1.0',
  POLICY_QCP_L:      '0.4.0.194112.1.1',
};

// OID-ul extensiei X.509 „certificatePolicies" — util apelanților.
export const OID_CERT_POLICIES = '2.5.29.32';

/** Normalizează o listă de OID-uri primită sub orice formă tolerabilă. */
function _oidSet(v) {
  const out = new Set();
  if (!v) return out;
  const arr = Array.isArray(v) ? v : [v];
  for (const x of arr) {
    if (typeof x === 'string' && x.trim()) out.add(x.trim());
  }
  return out;
}

/**
 * Normalizează denumirile de key usage.
 * Acceptă array SAU șir separat prin virgulă (forma produsă azi de
 * `_extractCertInfo` din certificate-verify.mjs).
 * `contentCommitment` e denumirea RFC 5280 pentru bitul istoric
 * `nonRepudiation` — sunt ACELAȘI bit, deci ambele trebuie acceptate;
 * altfel certificatele reale (care raportează `contentCommitment`) ar fi
 * declasate pe nedrept.
 */
function _kuSet(v) {
  const out = new Set();
  if (!v) return out;
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  for (const x of arr) {
    const k = String(x || '').toLowerCase().replace(/[^a-z]/g, '');
    if (k) out.add(k);
  }
  return out;
}

/**
 * @param {object} input
 * @param {string[]} input.qcStatementOids — OID-urile găsite în extensia 1.3.6.1.5.5.7.1.3
 * @param {string[]} input.certPolicyOids  — OID-urile găsite în extensia 2.5.29.32
 * @param {string[]|string} input.keyUsage — ex. ['digital_signature','non_repudiation']
 * @returns {{
 *   qcCompliance: boolean, qscd: boolean, esign: boolean, nonRepudiation: boolean,
 *   isQualifiedCert: boolean, isQES: boolean, evidence: string[], missing: string[]
 * }}
 */
export function evaluateQcEvidence(input = {}) {
  const inp     = (input && typeof input === 'object') ? input : {};
  const qcOids  = _oidSet(inp.qcStatementOids);
  const polOids = _oidSet(inp.certPolicyOids);
  const ku      = _kuSet(inp.keyUsage);

  // QcCompliance: singura declarație care spune „acesta e certificat calificat
  // în sensul eIDAS". Prezența extensiei, fără acest OID, nu declară nimic.
  const qcCompliance = qcOids.has(QC_OID.COMPLIANCE);

  // QSCD: fie declarația explicită QcSSCD, fie o politică de certificare care
  // implică prin definiție un dispozitiv calificat (QCP-n-qscd / QCP-l-qscd).
  // Sunt dovezi echivalente — EN 319 411-2 leagă politica de QSCD.
  const qscdPolicy = polOids.has(QC_OID.POLICY_QCP_N_QSCD) || polOids.has(QC_OID.POLICY_QCP_L_QSCD);
  const qscd = qcOids.has(QC_OID.SSCD) || qscdPolicy;

  // esign: ETSI EN 319 412-5 tratează ABSENȚA lui QcType ca esign implicit.
  // Dar dacă QcType E prezent și indică ESEAL (sigiliu) sau WEB (autentificare
  // site), certificatul NU e pentru semnătura unei persoane ⇒ esign = false.
  const hasType = qcOids.has(QC_OID.TYPE_ESIGN) || qcOids.has(QC_OID.TYPE_ESEAL) || qcOids.has(QC_OID.TYPE_WEB);
  const esign   = qcOids.has(QC_OID.TYPE_ESIGN) || !hasType;

  // nonRepudiation / contentCommitment — bitul care leagă cheia de asumarea
  // conținutului. Fără el, cheia nu e destinată semnăturii cu efect juridic.
  const nonRepudiation = ku.has('nonrepudiation') || ku.has('contentcommitment');

  const isQualifiedCert = qcCompliance && esign;

  // eIDAS art. 3 pct. 12: semnătura electronică CALIFICATĂ cere certificat
  // calificat ȘI un dispozitiv calificat de creare a semnăturii (QSCD).
  // Fără dovada QSCD, maximul demonstrabil e „avansată cu certificat calificat"
  // (AdES-QC) — NU QES. ⛔ Fără fallback „dacă nu știm, presupunem calificat".
  const isQES = isQualifiedCert && qscd && nonRepudiation;

  const evidence = [];
  const missing  = [];

  if (qcCompliance) evidence.push('QcCompliance (certificat calificat eIDAS)');
  else              missing.push('QcCompliance');

  if (qcOids.has(QC_OID.SSCD))   evidence.push('QcSSCD (cheie în dispozitiv calificat)');
  else if (qscdPolicy)           evidence.push('Politică QCP-*-qscd (dispozitiv calificat)');
  else                           missing.push('dovadă QSCD (QcSSCD sau politică QCP-*-qscd)');

  if (qcOids.has(QC_OID.TYPE_ESIGN))      evidence.push('QcType-esign (semnătură de persoană)');
  else if (esign)                         evidence.push('QcType absent — esign implicit (EN 319 412-5)');
  else if (qcOids.has(QC_OID.TYPE_ESEAL)) missing.push('QcType indică sigiliu (eseal), nu semnătură de persoană');
  else                                    missing.push('QcType indică autentificare web, nu semnătură');

  if (nonRepudiation) evidence.push('key usage: non-repudiation');
  else                missing.push('key usage non-repudiation');

  if (qcOids.has(QC_OID.PDS)) evidence.push('QcPDS (declarație PKI publicată)');

  return { qcCompliance, qscd, esign, nonRepudiation, isQualifiedCert, isQES, evidence, missing };
}

/**
 * Scanează un DER și întoarce toate OID-urile din el (etichetă 0x06).
 * Deliberat TOLERANT: nu construiește arborele ASN.1, doar caută OID-uri.
 * Ne interesează apartenența la o mulțime cunoscută, nu structura — iar un
 * parser strict s-ar rupe pe codificări legale dar neobișnuite (așa cum s-a
 * întâmplat deja la parsarea CMS a acestor PDF-uri).
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|number[]} buf
 * @returns {string[]} OID-uri în notație dot, fără duplicate, în ordinea găsirii
 */
export function derOids(buf) {
  let b;
  try {
    if (!buf) return [];
    if (buf instanceof ArrayBuffer) b = new Uint8Array(buf);
    else if (ArrayBuffer.isView(buf)) b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    else if (Array.isArray(buf)) b = Uint8Array.from(buf);
    else return [];
  } catch { return []; }

  const seen = new Set();
  const out  = [];

  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] !== 0x06) continue;
    const len = b[i + 1];
    // Lungime pe formă scurtă, 1..16 octeți — acoperă orice OID real.
    if (len < 1 || len > 16) continue;
    const start = i + 2;
    if (start + len > b.length) continue;

    const oid = _decodeOid(b, start, len);
    if (oid) {
      if (!seen.has(oid)) { seen.add(oid); out.push(oid); }
      i = start + len - 1; // sărim peste corp
    }
  }
  return out;
}

/** Decodează corpul unui OID DER; întoarce null dacă nu decodează curat. */
function _decodeOid(b, start, len) {
  const end   = start + len;
  const parts = [];
  let value   = 0;
  let pending = false;

  for (let i = start; i < end; i++) {
    const byte = b[i];
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if (byte & 0x80) { pending = true; continue; }
    if (parts.length === 0) {
      const a = Math.min(Math.floor(value / 40), 2);
      parts.push(a, value - a * 40);
    } else {
      parts.push(value);
    }
    value   = 0;
    pending = false;
  }
  // Ultimul octet avea bitul de continuare setat ⇒ codificare trunchiată.
  if (pending) return null;
  if (parts.length < 2) return null;
  return parts.join('.');
}

/**
 * Extrage denumirile de key usage dintr-un DER de BIT STRING (extensia 2.5.29.15).
 * Pur, fără dependențe — folosit de motorul care nu are extensia deja parsată.
 * @param {Buffer|Uint8Array|ArrayBuffer} der
 * @returns {string[]}
 */
export function keyUsageFromDer(der) {
  let b;
  try {
    if (!der) return [];
    if (der instanceof ArrayBuffer) b = new Uint8Array(der);
    else if (ArrayBuffer.isView(der)) b = new Uint8Array(der.buffer, der.byteOffset, der.byteLength);
    else return [];
  } catch { return []; }
  if (b.length === 0) return [];

  // Acceptă atât DER-ul complet (03 len unusedBits …) cât și doar corpul
  // BIT STRING-ului (unusedBits + octeți), cum îl expune asn1js.
  let bits;
  if (b.length >= 3 && b[0] === 0x03) bits = b.subarray(3);
  else if (b.length >= 2 && b[0] <= 7) bits = b.subarray(1);
  else bits = b;
  if (!bits || bits.length === 0) return [];

  const byte = bits[0];
  const out  = [];
  if (byte & 0x80) out.push('digitalSignature');
  if (byte & 0x40) out.push('contentCommitment'); // == nonRepudiation
  if (byte & 0x20) out.push('keyEncipherment');
  return out;
}
