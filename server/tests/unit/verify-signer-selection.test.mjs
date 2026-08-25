/**
 * #145 — verificatorul public alegea `certificates[0]` drept certificat
 * semnatar. În CMS, `certificates` e un SET (RFC 5652) — sac NEORDONAT —
 * iar în fișierele produse de fluxul STS primul element este RĂDĂCINA.
 *
 * Cascada defectului: rădăcina are cheie RSA → ramura RSA verifică o
 * semnătură ECDSA → „Semnătură RSA INVALIDĂ" pe un act administrativ VALID.
 *
 * Testul rulează CAPĂT-LA-CAPĂT prin `verifyPdfSignatures`, pe o fixtură
 * reală (adeverință-tip NECOMPLETATĂ, semnată în staging — fără date ale
 * vreunui cetățean).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyPdfSignatures } from '../../verify.mjs';

const HERE     = dirname(fileURLToPath(import.meta.url));
const FIXTURE  = join(HERE, '..', 'fixtures', 'sts-signed-staging.pdf');

// Adevărul de teren al fixturii (măsurat pe documentul real).
const SIGNER_CN     = 'Barbu Ilie-Mircea';
const SIGNER_SERIAL = '801020018ECD4A7F05';

describe('#145 — certificatul semnatar se alege din SignerInfo, nu de pe poziția 0', () => {
  let out, sig;

  beforeAll(async () => {
    if (!existsSync(FIXTURE)) {
      throw new Error(
        `Fixtura lipsește: ${FIXTURE}\n` +
        'Pune documentul semnat în staging acolo (vezi PROMPT-145, Etapa A).'
      );
    }
    out = await verifyPdfSignatures(readFileSync(FIXTURE));
    sig = out.signatures?.[0];
  });

  it('fixtura conține exact o semnătură parsabilă', () => {
    expect(out.error).toBeUndefined();
    expect(out.signatureCount).toBe(1);
    expect(sig).toBeTruthy();
    expect(sig.errors).toEqual([]);
  });

  // ⭐⭐ 1 — testul lotului
  it('⭐⭐ L2 (semnătura criptografică) e VALIDĂ', () => {
    expect(sig.levels.L2.ok).toBe(true);
  });

  // ⭐⭐ 2 — certificatul raportat e al SEMNATARULUI, nu rădăcina
  it('⭐⭐ certificatul raportat e al semnatarului (CN + serie), nu rădăcina', () => {
    expect(sig.certificate).toBeTruthy();
    expect(sig.certificate.subject.CN).toBe(SIGNER_CN);
    // Nota: `serialNumber` e randat din DER, deci poate purta octetul `00` de
    // aliniere a semnului (convenție PREEXISTENTĂ, identică în celălalt motor —
    // vezi certificate-verify.mjs:476). Comparăm valoarea, nu padding-ul.
    expect(sig.certificate.serialNumber.replace(/^0+/, '')).toBe(SIGNER_SERIAL);
  });

  // ⭐ 3
  it('⭐ L1 (messageDigest == sha256(ByteRange)) e adevărat', () => {
    expect(sig.levels.L1.ok).toBe(true);
  });

  // ⭐ 4 — capătul-la-capăt care lipsea la #144
  it('⭐ isQES === true, cu dovadă (evaluarea calificării vede certul corect)', () => {
    expect(sig.isQES).toBe(true);
    expect(sig.levels.L6.ok).toBe(true);
    expect(Array.isArray(sig.levels.L6.evidence)).toBe(true);
    expect(sig.levels.L6.evidence.length).toBeGreaterThan(0);
  });

  // 6 — valabilitatea e a semnatarului (2024→2027), nu a rădăcinii (2017→2042)
  it('valabilitatea raportată e a semnatarului (2024→2027)', () => {
    expect(new Date(sig.certificate.notBefore).getUTCFullYear()).toBe(2024);
    expect(new Date(sig.certificate.notAfter).getUTCFullYear()).toBe(2027);
  });

  // 7
  it('lanțul raportat NU marchează certificatul semnatarului drept CA', () => {
    const entry = sig.chain.find(c => c.CN === SIGNER_CN);
    expect(entry).toBeTruthy();
    expect(entry.isSelfSigned).toBe(false);
  });

  it('nu se emite avertismentul de ultimă instanță (selecția a reușit)', () => {
    expect(sig.warnings.join(' ')).not.toMatch(/nu a putut fi identificat/i);
  });
});

// ── E3 — regresie: intrări degenerate nu aruncă ───────────────────────────
describe('#145/E3 — PDF nesemnat / trunchiat ⇒ eroare curată', () => {
  it('PDF fără semnături ⇒ { ok:false, error:"no_signatures" }', async () => {
    const out = await verifyPdfSignatures(Buffer.from('%PDF-1.7\n%%EOF\n'));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_signatures');
  });

  it('CMS trunchiat ⇒ eroare raportată, fără excepție nefiltrată', async () => {
    const fake = Buffer.from(
      '%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <30820102deadbeef>\n%%EOF\n'
    );
    const out = await verifyPdfSignatures(fake);
    expect(out.ok).toBe(false);
    const s = out.signatures?.[0];
    if (s) expect(s.errors.length).toBeGreaterThan(0);
  });
});
