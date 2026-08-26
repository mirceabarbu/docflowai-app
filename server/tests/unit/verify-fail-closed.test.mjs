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
  // #151 — până la #151, `verify.mjs` construia lanțul iterând `certs` în
  // ordinea din CMS și testa „lipsește rădăcina?" doar pe ULTIMUL element;
  // pe fixtura reală asta fabrica o rădăcină DEDUSĂ duplicat (rădăcina reală
  // era deja în listă, pe altă poziție) ⇒ L4.ok era `null`. Testul ĂSTA
  // (creat la #149) fixa acel `null` ca „așteptat". După #151 (construcție
  // prin urmărirea emitentului, nu prin ordine) lanțul real e complet și
  // fără deducere ⇒ L4.ok e acum `true`. Invarianta REALĂ pe care testul o
  // pinuiește — „L4 nu intră în formula verdictului, indiferent de valoare"
  // — rămâne verificată mai jos, direct pe `computeVerdict`, cu un caz
  // sintetic de rădăcină dedusă (vezi și verify-chain-order.test.mjs, cazul 3,
  // pentru dovada că deducerea încă funcționează când rădăcina chiar lipsește).
  it('⭐ 5. fixtura reală ⇒ L4.ok true (fix #151), iar isValid rămâne neschimbat', async () => {
    const out = await verifyPdfSignatures(readFileSync(FIXTURE));
    const sig = out.signatures[0];
    expect(sig.chain.some(c => c.isInferred === true)).toBe(false);
    expect(sig.levels.L4.ok).toBe(true);
    expect(sig.isValid).toBe(true);
  });

  it('⭐ L4.ok null (rădăcină dedusă, caz sintetic) NU schimbă verdictul', () => {
    expect(computeVerdict(lvl({ L4: null }))).toBe(true);
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

describe('#147 — certificate-verify.mjs a devenit fail-closed, pe un L2 REAL', () => {
  it('⭐ 7. fostul pinning #149 s-a inversat: L2 e acum verificat, nu `null`', async () => {
    // ISTORIC: până la #147 acest test asertase `L2.ok === null` + `isValid === true`
    // — fail-open DELIBERAT, fiindcă motorul nu avea verificare ECDSA reală și o
    // formulă strânsă ar fi tipărit „invalid" pe toate semnăturile STS. #147 a
    // portat nucleul criptografic; pinning-ul a devenit roșu exact cum trebuia
    // și a fost rescris aici cu așteptarea inversă.
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s = out.signatures[0];
    expect(s.levels.L2.ok).toBe(true);
    expect(s.levels.L3.ok).toBe(true);
    expect(s.isValid).toBe(true);
  });

  it('⭐ aceeași combinație de niveluri (L1 null + L2 null + L3 true) ⇒ isValid FALSE', () => {
    // Combinația pe care #149 o pinuia ca „true, intenționat" în acest motor.
    // Acum motorul Raportului folosește `computeVerdict`, deci dă `false`.
    expect(computeVerdict(lvl({ L1: null, L2: null }))).toBe(false);
  });

  it('#149/E2 — marca temporală e detectată, nu validată', async () => {
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s = out.signatures[0];
    expect(s.padesLevel).toBe('B-T');
    expect(s.timestampValidated).toBe(false);
  });
});
