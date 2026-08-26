/**
 * #149 — „nu afirma ce n-ai dovedit": fail-closed în motorul public de verificare.
 *
 * Înainte de #149 verdictul se calcula cu `ok !== false`, deci `null`
 * („nu am putut verifica") trecea drept adevărat, iar `verify.mjs` mai scria
 * explicit `true` pe integritate în ramura `else` și în `catch`. Rezultatul:
 * pagina publică putea declara un document valid fără să fi confirmat nimic.
 *
 * ⛔ SCOP: fail-closed se aplică STRICT pe L1/L2/L3 — cele trei care compun
 * verdictul. L5 (OCSP) și L4 (lanț) rămân DELIBERAT în afara formulei.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeVerdict, verifyPdfSignatures } from '../../verify.mjs';
import { verifyPdfSignatures as verifyTrustEngine } from '../../services/certificate-verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(ROOT, 'server', 'tests', 'fixtures', 'sts-signed-staging.pdf');

// ATENȚIE: `??` NU merge aici — `null` e o valoare semnificativă în acest test
// (înseamnă „nu am putut verifica"), nu o valoare lipsă.
const lvl = (o = {}) => {
  const pick = (k, dflt) => ({ ok: k in o ? o[k] : dflt });
  return {
    L1: pick('L1', true),
    L2: pick('L2', true),
    L3: pick('L3', true),
    L4: pick('L4', true),
    L5: pick('L5', null),
  };
};

describe('#149 — `null` nu mai devine „valid"', () => {
  it('⭐⭐ 1. L1 null (integritate neverificată) + L2/L3 true ⇒ isValid false', () => {
    // Codul VECHI: `L1.ok !== false` ⇒ true ⇒ isValid TRUE (afirmație nedovedită).
    expect(computeVerdict(lvl({ L1: null }))).toBe(false);
  });

  it('⭐⭐ 2. L2 null (algoritm necunoscut) + restul true ⇒ isValid false', () => {
    // Codul VECHI: `L2.ok !== false` ⇒ true ⇒ isValid TRUE.
    expect(computeVerdict(lvl({ L2: null }))).toBe(false);
  });

  it('⭐ 3. L1/L2/L3 toate true ⇒ isValid true', () => {
    expect(computeVerdict(lvl())).toBe(true);
  });

  it('⭐⭐ 4. L5 null + L1/L2/L3 true ⇒ isValid TRUE (L5 e în afara formulei)', () => {
    // Pinuiește decizia de SCOP. L5 e null la majoritatea documentelor reale;
    // dacă cineva îl adaugă în formulă, fiecare act al primăriei devine
    // „neconcludent" — o supra-corecție mai gravă decât bug-ul. Testul cade.
    expect(computeVerdict(lvl({ L5: null }))).toBe(true);
    expect(computeVerdict(lvl({ L5: false }))).toBe(true);
  });

  it('L4 rămâne, ca și înainte, în afara formulei', () => {
    expect(computeVerdict(lvl({ L4: null }))).toBe(true);
    expect(computeVerdict(lvl({ L4: false }))).toBe(true);
  });

  it('`false` rămâne `false` — fail-closed nu înmoaie nimic', () => {
    expect(computeVerdict(lvl({ L1: false }))).toBe(false);
    expect(computeVerdict(lvl({ L2: false }))).toBe(false);
    expect(computeVerdict(lvl({ L3: false }))).toBe(false);
  });

  it('nivel lipsă cu totul ⇒ false, nu „valid"', () => {
    expect(computeVerdict({})).toBe(false);
    expect(computeVerdict(undefined)).toBe(false);
  });
});

describe('#149 — lanțul nu se mai declară valid pe lungime', () => {
  it('⭐ 5. lanț cu rădăcină DEDUSĂ ⇒ L4.ok null, iar isValid NU se schimbă', async () => {
    const out = await verifyPdfSignatures(readFileSync(FIXTURE));
    const sig = out.signatures[0];
    // Rădăcina e adăugată de noi din issuerCN (isInferred: true, verify.mjs ~549/562).
    expect(sig.chain.some(c => c.isInferred === true)).toBe(true);
    expect(sig.levels.L4.ok).toBe(null);
    // ...și totuși documentul rămâne valid: L4 nu intră în verdict.
    expect(sig.isValid).toBe(true);
  });
});

describe('#149 — ancora de non-regresie pe fixtura reală', () => {
  it('⭐⭐ 6. sts-signed-staging.pdf ⇒ isValid true, identic cu Etapa A', async () => {
    const out = await verifyPdfSignatures(readFileSync(FIXTURE));
    expect(out.signatures).toHaveLength(1);
    const s = out.signatures[0];

    expect(s.levels.L1.ok).toBe(true);   // acum DOVEDIT, nu presupus
    expect(s.levels.L2.ok).toBe(true);
    expect(s.levels.L3.ok).toBe(true);
    expect(s.levels.L5.ok).toBe(null);
    expect(s.levels.L6.ok).toBe(true);
    expect(s.isValid).toBe(true);
    expect(s.isQES).toBe(true);
  });

  it('L1 se calculează pe CMS DETAȘAT (cazul PAdES real), comparând messageDigest', async () => {
    // Regresia pe care o previne: comparația era gardată de `eContent`, care în
    // PAdES lipsește ÎNTOTDEAUNA ⇒ integritatea nu era verificată niciodată.
    const out = await verifyPdfSignatures(readFileSync(FIXTURE));
    const L1 = out.signatures[0].levels.L1;
    expect(L1.embeddedHash).toBeTruthy();
    expect(L1.computedHash).toBeTruthy();
    expect(L1.embeddedHash.toLowerCase()).toBe(L1.computedHash.toLowerCase());
  });

  it('un document MODIFICAT după semnare ⇒ L1 false ⇒ isValid false', async () => {
    const bytes = Buffer.from(readFileSync(FIXTURE));
    // Alterăm un octet din zona acoperită de ByteRange (începutul documentului).
    bytes[1000] = bytes[1000] ^ 0xff;
    const out = await verifyPdfSignatures(bytes);
    const s = out.signatures[0];
    expect(s.levels.L1.ok).toBe(false);
    expect(s.isValid).toBe(false);
  });
});

describe('#149 — certificate-verify.mjs rămâne DELIBERAT fail-open până la #147', () => {
  it('⭐ 7. L2 null (ECDSA în catch) + L3 true ⇒ isValid TRUE acolo, intenționat', async () => {
    // A NU se „repara" aici. Cu formula strânsă acum, `isValid` ar deveni false
    // pe TOATE semnăturile STS, iar Raportul de încredere le-ar tipări ca
    // invalide — fals negativ pe un act oficial. „Nu am verificat" nu înseamnă
    // „invalid", exact cum nu înseamnă „valid". Întâi #147 dă acelui motor o
    // verificare ECDSA reală; abia apoi formula devine fail-closed acolo.
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s = out.signatures[0];
    expect(s.levels.L2.ok).toBe(null);
    expect(s.levels.L3.ok).toBe(true);
    expect(s.isValid).toBe(true);
  });

  it('#149/E2 — marca temporală e detectată, nu validată', async () => {
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s = out.signatures[0];
    expect(s.padesLevel).toBe('B-T');
    expect(s.timestampValidated).toBe(false);
  });
});
