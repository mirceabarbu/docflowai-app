/**
 * #151 — lanțul de certificare se construiește URCÂND din emitent în emitent
 * (pornind de la semnatar), NU iterând `certs` în ordinea din CMS (SET
 * neordonat, RFC 5652). Codul vechi testa „lipsește rădăcina?" doar pe
 * ULTIMUL element din listă — pe fixtura reală (`certs` = [rădăcină, semnatar,
 * CA intermediar]) asta fabrica o rădăcină „dedusă" DUPLICAT (rădăcina reală
 * era deja în listă, pe poziția 0), deși lanțul era complet.
 *
 * Vezi PROMPT-151. `_buildCertChain` (verify.mjs) e funcția PURĂ extrasă din
 * blocul L4 — testabilă direct cu certificate sintetice (pkijs.Certificate).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyPdfSignatures, _buildCertChain } from '../../verify.mjs';

const HERE    = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'sts-signed-staging.pdf');

let pkijs, asn1js;
let rdn, mkCert;

beforeAll(async () => {
  pkijs  = await import('pkijs');
  asn1js = await import('asn1js');

  rdn = (cn) => new pkijs.RelativeDistinguishedNames({
    typesAndValues: [new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3', value: new asn1js.PrintableString({ value: cn }),
    })],
  });

  // subjectCN === issuerCN ⇒ self-signed (comparație pe DER al RDN-ului).
  mkCert = (subjectCN, issuerCN) => {
    const c = new pkijs.Certificate();
    c.subject = rdn(subjectCN);
    c.issuer  = rdn(issuerCN);
    return c;
  };
});

describe('#151/A — măsurătoare pe fixtura reală (dovadă a bug-ului vechi)', () => {
  // ⭐⭐ 1 — testul lotului. Cade pe codul vechi (iterare pe ordinea CMS):
  // ultimul cert din CMS era CA-ul intermediar ⇒ deducea o rădăcină duplicat
  // și `L4.ok` era `null` în loc de `true`.
  it('⭐⭐ fixtura reală ⇒ L4.ok === true, fără niciun element isInferred', async () => {
    if (!existsSync(FIXTURE)) throw new Error(`Fixtura lipsește: ${FIXTURE}`);
    const out = await verifyPdfSignatures(readFileSync(FIXTURE));
    const sig = out.signatures[0];
    expect(sig.levels.L4.ok).toBe(true);
    expect(sig.chain.some(c => c.isInferred === true)).toBe(false);
    expect(sig.chain.length).toBe(3); // semnatar, CA intermediar, rădăcină REALĂ (nu dedusă)
  });
});

describe('#151/B — _buildCertChain urcă prin emitent, nu prin ordinea din listă', () => {
  // ⭐⭐ 2 — chiar bug-ul: ordine amestecată (root, leaf, intermediar) ⇒
  // lanțul trebuie să iasă ordonat leaf→root, fără nicio deducere.
  it('⭐⭐ certificate în ordine amestecată ⇒ lanț ordonat leaf→root, fără deducere', () => {
    const root = mkCert('ROOT CA', 'ROOT CA'); // self-signed
    const leaf = mkCert('Semnatar', 'CA Intermediar');
    const mid  = mkCert('CA Intermediar', 'ROOT CA');

    // Ordinea din CMS: [root, leaf, intermediar] — NU leaf→root.
    const certs = [root, leaf, mid];

    const chain = _buildCertChain(leaf, certs, pkijs);
    expect(chain.map(c => c.CN)).toEqual(['Semnatar', 'CA Intermediar', 'ROOT CA']);
    expect(chain.some(c => c.isInferred === true)).toBe(false);
    expect(chain[chain.length - 1].isSelfSigned).toBe(true);
  });

  // ⭐ 3 — rădăcina ABSENTĂ din listă ⇒ deducerea rămâne (comportament legitim).
  it('⭐ rădăcină absentă din certs ⇒ se deduce, isInferred:true, L4.ok would be null', () => {
    const leaf = mkCert('Semnatar', 'CA Intermediar');
    const mid  = mkCert('CA Intermediar', 'ROOT CA'); // emitentul ROOT CA nu e în listă

    const certs = [leaf, mid]; // fără rădăcină
    const chain = _buildCertChain(leaf, certs, pkijs);

    expect(chain.length).toBe(3); // semnatar, intermediar, + intrarea dedusă
    expect(chain[chain.length - 1].isInferred).toBe(true);
    expect(chain[chain.length - 1].CN).toBe('ROOT CA');

    // aceeași formulă ca în verify.mjs pentru L4.ok
    const inferred = chain.some(c => c.isInferred === true);
    const ok = chain.length >= 2 ? (inferred ? null : true) : false;
    expect(ok).toBe(null);
  });

  // ⭐ 4 — un certificat din CMS în afara căii reale nu trebuie să apară în chain.
  it('⭐ certificat în afara căii (ex. OCSP responder) nu apare în chain', () => {
    const root = mkCert('ROOT CA', 'ROOT CA');
    const leaf = mkCert('Semnatar', 'CA Intermediar');
    const mid  = mkCert('CA Intermediar', 'ROOT CA');
    const ocspResponder = mkCert('OCSP Responder', 'CA Intermediar'); // NU e pe calea leaf→root

    const certs = [root, leaf, mid, ocspResponder];
    const chain = _buildCertChain(leaf, certs, pkijs);

    expect(chain.map(c => c.CN)).toEqual(['Semnatar', 'CA Intermediar', 'ROOT CA']);
    expect(chain.some(c => c.CN === 'OCSP Responder')).toBe(false);
  });

  // ⭐⭐ 5 — protecție la buclă: două certificate care se emit reciproc.
  it('⭐⭐ certificate încrucișat-semnate (buclă) ⇒ funcția se oprește, nu blochează', () => {
    const leaf = mkCert('Semnatar', 'CA-1');
    const ca1  = mkCert('CA-1', 'CA-2'); // emis de CA-2
    const ca2  = mkCert('CA-2', 'CA-1'); // emis de CA-1 — buclă CA-1 ⇄ CA-2, niciunul self-signed

    const certs = [leaf, ca1, ca2];

    const start = Date.now();
    const chain = _buildCertChain(leaf, certs, pkijs);
    expect(Date.now() - start).toBeLessThan(2000);

    // se oprește la a doua vizitare a lui CA-1 sau CA-2 — nu explodează în buclă infinită
    expect(chain.length).toBeLessThanOrEqual(4);
    expect(chain.some(c => c.isInferred === true)).toBe(false); // s-a oprit pe buclă, nu pe emitent lipsă
  }, 5000);

  // ⭐ 6 — un singur certificat, self-signed.
  it('⭐ un singur certificat self-signed ⇒ chain.length===1, L4.ok===false', () => {
    const onlyRoot = mkCert('ROOT CA', 'ROOT CA');
    const certs = [onlyRoot];
    const chain = _buildCertChain(onlyRoot, certs, pkijs);

    expect(chain.length).toBe(1);
    expect(chain[0].isSelfSigned).toBe(true);

    const inferred = chain.some(c => c.isInferred === true);
    const ok = chain.length >= 2 ? (inferred ? null : true) : false;
    expect(ok).toBe(false);
  });
});
