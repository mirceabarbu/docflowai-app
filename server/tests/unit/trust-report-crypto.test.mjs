/**
 * #147 — nucleul criptografic verificat, portat în motorul Raportului de încredere.
 *
 * Înainte de #147, `server/services/certificate-verify.mjs` cerea lui pkijs să
 * verifice semnătura contra bufferului CMS ÎNSUȘI (`sd.verify({ data: ab })`).
 * Pentru o semnătură PAdES detașată apelul nu poate reuși cu niciun algoritm:
 * pe fixtura reală arunca `SignedDataVerifyError: Message digest doesn't match`,
 * catch-ul punea `L2.ok = null`, iar formula veche (`ok !== false`) tipărea
 * totuși verdict pozitiv. Motorul Raportului NU confirmase criptografic
 * niciodată o semnătură.
 *
 * ⛔ `false` = „am verificat și NU se potrivește". `null` = „nu am putut
 * verifica". Testele de aici nu le confundă în nicio ramură.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyPdfSignatures as verifyTrustEngine } from '../../services/certificate-verify.mjs';
import { verifyPdfSignatures as verifyPublic, _selectSignerCert, computeVerdict } from '../../verify.mjs';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(ROOT, 'server', 'tests', 'fixtures', 'sts-signed-staging.pdf');

describe('#147 — L2 real în motorul Raportului de încredere', () => {
  it('⭐⭐ 1. fixtura reală ⇒ L2.ok === true (cade pe codul vechi, unde era null)', async () => {
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s   = out.signatures[0];
    expect(s.levels.L2.ok).toBe(true);
    // Nota trebuie să numească algoritmul REAL citit din SignerInfo, nu unul presupus.
    expect(s.levels.L2.note).toMatch(/ECDSA P-256\/SHA-256/);
    expect(s.isValid).toBe(true);
  });

  it('⭐⭐ 2. un octet inversat în ByteRange ⇒ L1.ok === false ȘI isValid === false', async () => {
    const bytes = Buffer.from(readFileSync(FIXTURE));
    bytes[1000] = bytes[1000] ^ 0xff;   // zonă acoperită de ByteRange
    const out = await verifyTrustEngine(bytes);
    const s   = out.signatures[0];
    expect(s.levels.L1.ok).toBe(false);
    expect(s.isValid).toBe(false);
  });

  it('⭐ 3. L1 true + L2 null + L3 true ⇒ isValid false (fail-closed)', () => {
    expect(computeVerdict({ L1: { ok: true }, L2: { ok: null }, L3: { ok: true } })).toBe(false);
  });

  it('⭐ 4. L5 null cu L1/L2/L3 true ⇒ isValid true (L5 rămâne în afara formulei)', () => {
    expect(computeVerdict({
      L1: { ok: true }, L2: { ok: true }, L3: { ok: true }, L4: { ok: null }, L5: { ok: null },
    })).toBe(true);
  });

  it('⭐ 6. ambele motoare dau ACELAȘI isValid pe fixtură (anti-redivergență)', async () => {
    const bytes = readFileSync(FIXTURE);
    const [pub, trust] = await Promise.all([verifyPublic(bytes), verifyTrustEngine(bytes)]);
    expect(trust.signatures).toHaveLength(pub.signatures.length);
    for (let i = 0; i < pub.signatures.length; i++) {
      expect(trust.signatures[i].isValid).toBe(pub.signatures[i].isValid);
      expect(trust.signatures[i].levels.L1.ok).toBe(pub.signatures[i].levels.L1.ok);
      expect(trust.signatures[i].levels.L2.ok).toBe(pub.signatures[i].levels.L2.ok);
      expect(trust.signatures[i].levels.L3.ok).toBe(pub.signatures[i].levels.L3.ok);
    }
  });

  // #150 (C3) — paritate L4 între motoare. NU e (încă) egalitate: pe fixtura
  // reală, `certs` din CMS vine în ordinea [rădăcină, semnatar, CA intermediar],
  // iar `verify.mjs` (motorul public, NO-TOUCH în acest lot) decide „rădăcină
  // dedusă" uitându-se DOAR la ULTIMUL element din listă — care aici e CA
  // intermediar, nu rădăcina (deja prezentă, dar pe poziția 0). Rezultă un
  // fals „Neconcludent" în motorul public, deși lanțul e complet din CMS.
  // `certificate-verify.mjs` (motorul Raportului) reconstruiește lanțul prin
  // urmărirea reală issuer→issuer și găsește corect rădăcina REALĂ din CMS —
  // `L4.ok = true` acolo e CORECT (regula #150/C2: nu strica un `true` corect).
  // Testul fixează divergența CUNOSCUTĂ ca să nu treacă neobservată o schimbare
  // viitoare; vezi raportul PROMPT-150, itemul 9.
  it('C3 — L4.ok diverge CUNOSCUT între motoare pe fixtură (bug de ordine în verify.mjs, NO-TOUCH)', async () => {
    const bytes = readFileSync(FIXTURE);
    const [pub, trust] = await Promise.all([verifyPublic(bytes), verifyTrustEngine(bytes)]);
    expect(pub.signatures[0].levels.L4.ok).toBe(null);
    expect(trust.signatures[0].levels.L4.ok).toBe(true);
  });

  it('L1 fără atribut messageDigest ⇒ null, nu true (fail-closed în ambele motoare)', () => {
    // Sursa: certificate-verify.mjs, ramura `else` a atributului msgDigest.
    const src = readFileSync(join(ROOT, 'server', 'services', 'certificate-verify.mjs'), 'utf8');
    expect(src).not.toMatch(/Hash intact \(atribut msgDigest absent\)/);
    expect(src).toMatch(/messageDigest lipseste din CMS/);
    // ...și nicio urmă din formula fail-open.
    expect(src.includes('ok !== false')).toBe(false);
  });

  // #150 (D) — validAtSigning fără signingTime e null (nedeterminat), nu true
  // (evaluat fals la "acum") nici false. Fixtura reală n-are signingTime (STS
  // nu pune atributul CMS — măsurat la #147), deci ăsta e cazul de zi cu zi.
  it('⭐ D. validAtSigning === null pe fixtura reală (fără signingTime declarat)', async () => {
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    const s = out.signatures[0];
    expect(s.signingTime).toBeFalsy();
    expect(s.certificate.validAtSigning).toBe(null);
  });

  it('tabelele de algoritmi/curbe NU sunt duplicate în al doilea motor', () => {
    const src = readFileSync(join(ROOT, 'server', 'services', 'certificate-verify.mjs'), 'utf8');
    expect(src).not.toMatch(/const\s+SIG_ALGS\s*=/);
    expect(src).not.toMatch(/const\s+EC_CURVES\s*=/);
    expect(src).not.toMatch(/const\s+DIGEST_ALGS\s*=/);
    expect(src).toMatch(/from '\.\.\/verify\.mjs'/);
  });
});

describe('#147/C — selecția semnatarului ține cont de EMITENT, nu doar de serie', () => {
  it('⭐⭐ 5. două certificate cu ACEEAȘI serie, emitenți diferiți ⇒ se alege cel corect', async () => {
    const pkijs  = await import('pkijs');
    const asn1js = await import('asn1js');

    const rdn = (cn) => new pkijs.RelativeDistinguishedNames({
      typesAndValues: [new pkijs.AttributeTypeAndValue({
        type: '2.5.4.3', value: new asn1js.PrintableString({ value: cn }),
      })],
    });
    const serialBytes = Buffer.from('00801020018ecd4a7f05', 'hex');
    const mkCert = (issuerCN, subjectCN) => {
      const c = new pkijs.Certificate();
      c.serialNumber = new asn1js.Integer({ valueHex: serialBytes });
      c.issuer  = rdn(issuerCN);
      c.subject = rdn(subjectCN);
      return c;
    };

    const wrong = mkCert('ALT CA — emitent diferit', 'Omonim Serie');
    const right = mkCert('STS Qualified CA II',      'Semnatar Corect');

    // `wrong` e PRIMUL în sac: o potrivire doar pe serie l-ar alege pe el.
    const certs = [wrong, right];
    const signedData = {
      signerInfos: [{ sid: { serialNumber: new asn1js.Integer({ valueHex: serialBytes }), issuer: rdn('STS Qualified CA II') } }],
    };

    const sel = _selectSignerCert(signedData, certs, pkijs);
    expect(sel.branch).toBe(1);
    expect(sel.cert).toBe(right);
    expect(sel.cert).not.toBe(wrong);
  });

  it('motorul Raportului nu mai are potrivirea locală doar-pe-serie', () => {
    // Codul vechi destructura `{ issuer, serialNumber }` și folosea DOAR seria.
    const src = readFileSync(join(ROOT, 'server', 'services', 'certificate-verify.mjs'), 'utf8');
    expect(src).not.toMatch(/const \{ issuer, serialNumber \} = /);
    expect(src).toMatch(/_selectSignerCert\(sd, certs, pkijs\)/);
  });

  it('fixtura reală e prinsă pe ramura 1 (emitent DER + serie), nu pe euristică', async () => {
    // Cade pe codul vechi: `signerCertSource` nici nu exista în acest motor, iar
    // metoda 1 locală nu se declanșa deloc (sid.issuerAndSerialNumber e absent
    // în pkijs actual) — semnatarul era prins de euristica de la metoda 2.
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    expect(out.signatures[0].signerCertSource).toBe(1);
    expect(out.signatures[0].certificate.subject.CN).toBe('Barbu Ilie-Mircea');
  });

  // #150 (E) — CANAR: `_selectSignerCert` e acum într-un SINGUR loc (verify.mjs),
  // folosit de AMBELE motoare. La #147 s-a descoperit că ramura 1 (emitent DER +
  // serie, `sid.issuerAndSerialNumber`) era cod mort pe pkijs actual, iar
  // semnatarul era în schimb prins TĂCUT de euristica de la ramura 2 — funcțional
  // corect, dar fragil: dacă euristica ar fi ghicit greșit, nimic n-ar fi semnalat-o.
  // Acest test fixează `branch === 1` pe fixtura reală. DACĂ PICĂ: o versiune
  // viitoare de pkijs a schimbat din nou forma lui `sid`, selecția a degradat
  // (din nou) pe euristică, iar asta trebuie să facă CI-ul ROȘU — nu să fie
  // „reparat" prin relaxarea aserțiunii (ex. `branch <= 3`), ceea ce ar ascunde
  // exact fragilitatea pe care testul există s-o prindă.
  it('⭐ canar — _selectSignerCert rămâne pe ramura 1 (emitent DER + serie) pe fixtura reală', async () => {
    const out = await verifyTrustEngine(readFileSync(FIXTURE));
    expect(out.signatures[0].signerCertSource).toBe(1);
  });
});
