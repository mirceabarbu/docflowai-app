/**
 * #159 (P0) — poarta de regresie pe serializarea publică a fluxului.
 *
 * Testul importă implementarea DE PRODUCȚIE (`server/services/flow-dto.mjs`),
 * nu o redeclară. Scanerele sunt RECURSIVE și lucrează pe lista
 * `FORBIDDEN_DTO_KEYS` exportată din producție: un câmp-secret nou, adăugat
 * mâine oriunde în DTO (la orice adâncime), cade aici înainte de deploy.
 */
import { describe, it, expect } from 'vitest';
import {
  stripSensitive,
  stripPdfB64,
  FORBIDDEN_DTO_KEYS,
  SIGNER_SECRET_KEYS,
} from '../../services/flow-dto.mjs';

// Markerul PEM se construiește la runtime, ca fixtura să nu conțină un literal
// care să deranjeze grep-urile de securitate ulterioare pe repo.
const PEM_MARKER = '-----' + 'BEGIN' + ' RSA PRIVATE KEY' + '-----';

/** Parcurge recursiv obiecte + array-uri și întoarce cheile interzise găsite,
 *  cu calea lor (pentru un mesaj de eșec util). */
function findForbiddenKeys(node, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_DTO_KEYS.includes(k)) found.push(`${path}.${k}`);
      findForbiddenKeys(v, `${path}.${k}`, found);
    }
  }
  return found;
}

/** Aceeași parcurgere, dar colectează toate valorile string din DTO. */
function collectStrings(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach(v => collectStrings(v, out)); return out; }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
  return out;
}

const TOKEN_1 = 'tok-semnatar-unu-abc123';
const TOKEN_2 = 'tok-semnatar-doi-def456';

function makeFlow(extra = {}) {
  return {
    flowId: 'PMX_A1B2C3D4E5',
    docName: 'Contract achizitie.pdf',
    status: 'in_progress',
    events: [{ type: 'CREATED', at: '2026-08-01T10:00:00Z' }],
    pdfB64: 'JVBERi0xLjcK',
    signedPdfB64: 'JVBERi0xLjcSIGNED',
    _rawPdf_0: 'JVBERi1yYXcw',
    _rawPdf_1: 'JVBERi1yYXcx',
    signers: [
      {
        name: 'Ionescu Ion',
        email: 'ion@example.ro',
        role: 'ÎNTOCMIT',
        status: 'signed',
        token: TOKEN_1,
        stsToken: 'oauth-access-token-semnatar-1',
        stsProviderData: {
          privateKeyPem: `${PEM_MARKER}\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`,
          codeVerifier: 'pkce-code-verifier-1',
          state: 'state-1',
          nonce: 'nonce-1',
          clientId: 'client-id-institutie',
          kid: 'kid-1',
        },
      },
      {
        name: 'Popescu Maria',
        email: 'maria@example.ro',
        role: 'APROBAT',
        status: 'pending',
        token: TOKEN_2,
        stsToken: 'oauth-access-token-semnatar-2',
        stsProviderData: {
          privateKeyPem: `${PEM_MARKER}\nMIIEowIBAAKCAQEB...\n-----END RSA PRIVATE KEY-----`,
          codeVerifier: 'pkce-code-verifier-2',
          state: 'state-2',
          nonce: 'nonce-2',
          clientId: 'client-id-institutie',
          kid: 'kid-2',
        },
      },
    ],
    ...extra,
  };
}

describe('#159 flow-dto — niciun material criptografic nu părăsește serverul', () => {
  it('stripSensitive: scanerul recursiv nu găsește NICIO cheie interzisă', () => {
    const dto = stripSensitive(makeFlow(), TOKEN_1);
    expect(findForbiddenKeys(dto)).toEqual([]);
  });

  it('stripSensitive: nicio valoare string nu conține marker de cheie privată PEM', () => {
    const dto = stripSensitive(makeFlow(), TOKEN_1);
    const leaks = collectStrings(dto).filter(s => s.includes(PEM_MARKER));
    expect(leaks).toEqual([]);
  });

  it('stripSensitive: apelantul își primește tokenul, ceilalți semnatari NU', () => {
    const dto = stripSensitive(makeFlow(), TOKEN_1);
    expect(dto.signers).toHaveLength(2);
    expect(dto.signers[0].token).toBe(TOKEN_1);
    expect(dto.signers[1]).not.toHaveProperty('token');
    for (const s of dto.signers) {
      for (const k of SIGNER_SECRET_KEYS) expect(s).not.toHaveProperty(k);
    }
  });

  it('stripSensitive fără token de apelant: niciun token în DTO', () => {
    const dto = stripSensitive(makeFlow(), null);
    for (const s of dto.signers) expect(s).not.toHaveProperty('token');
    expect(findForbiddenKeys(dto)).toEqual([]);
  });

  it('stripSensitive: cheile `_rawPdf_<idx>` și PDF-urile dispar, hasPdf/hasSignedPdf rămân', () => {
    const dto = stripSensitive(makeFlow(), TOKEN_1);
    expect(dto).not.toHaveProperty('pdfB64');
    expect(dto).not.toHaveProperty('signedPdfB64');
    expect(Object.keys(dto).filter(k => k.startsWith('_rawPdf_'))).toEqual([]);
    expect(dto.hasPdf).toBe(true);
    expect(dto.hasSignedPdf).toBe(true);
  });

  it('stripSensitive: secrete ajunse din greșeală la RĂDĂCINA fluxului sunt eliminate', () => {
    const dto = stripSensitive(
      makeFlow({ stsProviderData: { privateKeyPem: PEM_MARKER }, stsToken: 'root-token' }),
      TOKEN_1,
    );
    expect(findForbiddenKeys(dto)).toEqual([]);
  });

  it('stripPdfB64: secretele dispar, dar tokenurile semnatarilor RĂMÂN (deliberat)', () => {
    // Comportament intenționat diferit de stripSensitive: varianta „ușoară" nu ia
    // decizia despre tokenuri — apelantul trebuie să știe ce face. Ce NU are voie
    // să iasă niciodată, nici pe această cale, e materialul de sesiune cloud.
    const dto = stripPdfB64(makeFlow());
    expect(findForbiddenKeys(dto)).toEqual([]);
    expect(collectStrings(dto).filter(s => s.includes(PEM_MARKER))).toEqual([]);
    expect(dto.signers[0].token).toBe(TOKEN_1);
    expect(dto.signers[1].token).toBe(TOKEN_2);
    expect(dto).not.toHaveProperty('pdfB64');
    expect(Object.keys(dto).filter(k => k.startsWith('_rawPdf_'))).toEqual([]);
    expect(dto.hasPdf).toBe(true);
    expect(dto.hasSignedPdf).toBe(true);
  });

  describe('caracterizare — comportamentul preexistent e neschimbat', () => {
    it('câmpurile normale ale fluxului trec neatinse', () => {
      const dto = stripSensitive(makeFlow(), TOKEN_1);
      expect(dto.flowId).toBe('PMX_A1B2C3D4E5');
      expect(dto.docName).toBe('Contract achizitie.pdf');
      expect(dto.status).toBe('in_progress');
      expect(dto.events).toEqual([{ type: 'CREATED', at: '2026-08-01T10:00:00Z' }]);
      expect(dto.signers[0].name).toBe('Ionescu Ion');
      expect(dto.signers[0].role).toBe('ÎNTOCMIT');
    });

    it('hasSignedPdf=true pe ramura Drive, chiar fără signedPdfB64', () => {
      const f = makeFlow({ storage: 'drive', driveFileLinkFinal: 'https://drive/x' });
      delete f.signedPdfB64;
      expect(stripSensitive(f, null).hasSignedPdf).toBe(true);

      const f2 = makeFlow({ storage: 'drive', driveFileIdFinal: 'fid-1' });
      delete f2.signedPdfB64;
      expect(stripSensitive(f2, null).hasSignedPdf).toBe(true);
    });

    it('hasSignedPdf=false fără signedPdfB64 și fără Drive; hasPdf=false fără pdfB64', () => {
      const f = makeFlow();
      delete f.signedPdfB64;
      delete f.pdfB64;
      const dto = stripSensitive(f, null);
      expect(dto.hasSignedPdf).toBe(false);
      expect(dto.hasPdf).toBe(false);
    });

    it('stripPdfB64 NU aplică ramura Drive (identic cu implementarea veche)', () => {
      const f = makeFlow({ storage: 'drive', driveFileLinkFinal: 'https://drive/x' });
      delete f.signedPdfB64;
      expect(stripPdfB64(f).hasSignedPdf).toBe(false);
    });
  });

  describe('intrări degenerate', () => {
    for (const fn of [stripSensitive, stripPdfB64]) {
      it(`${fn.name}: null/undefined/string trec prin, neschimbate`, () => {
        expect(fn(null)).toBe(null);
        expect(fn(undefined)).toBe(undefined);
        expect(fn('nu-e-obiect')).toBe('nu-e-obiect');
      });
    }

    it('stripSensitive: flux fără signers întoarce array gol', () => {
      const dto = stripSensitive({ flowId: 'X', pdfB64: 'aa' }, null);
      expect(dto.signers).toEqual([]);
    });

    it('stripPdfB64: flux fără signers nu inventează câmpul', () => {
      const dto = stripPdfB64({ flowId: 'X', pdfB64: 'aa' });
      expect(dto).not.toHaveProperty('signers');
    });

    it('semnatar null în listă nu aruncă', () => {
      const dto = stripSensitive({ flowId: 'X', signers: [null] }, null);
      expect(dto.signers).toHaveLength(1);
    });
  });
});
