/**
 * #160 — poarta de regresie pe SURSA scurgerii: cheia privată STS nu mai intră
 * niciodată în starea persistată a fluxului / a sesiunii bulk.
 *
 * Testul importă implementarea DE PRODUCȚIE
 * (`server/signing/providers/STSCloudProvider.mjs`) — nu o redeclară — și
 * completează cu o analiză statică a celor doi apelanți, ca o regresie viitoare
 * care ar readuce cheia în stare să cadă aici, nu în producție.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { STSCloudProvider } from '../../signing/providers/STSCloudProvider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

// Markerul PEM se construiește la runtime, ca fixtura să nu conțină un literal
// care să deranjeze grep-urile de securitate pe repo.
const PEM_MARKER = '-----' + 'BEGIN' + ' RSA PRIVATE KEY' + '-----';
const FAKE_KEY = `${PEM_MARKER}\nMIIFAKEKEYBYTES160\n-----END RSA PRIVATE KEY-----`;

/** Parcurgere recursivă: întoarce căile cheilor „interzise" găsite la orice adâncime. */
function findKeys(node, names, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findKeys(v, names, `${path}[${i}]`, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (names.includes(k)) found.push(`${path}.${k}`);
      findKeys(v, names, `${path}.${k}`, found);
    }
  }
  return found;
}

/** Aceeași parcurgere, dar colectează toate valorile string. */
function collectStrings(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach(v => collectStrings(v, out)); return out; }
  if (node && typeof node === 'object') for (const v of Object.values(node)) collectStrings(v, out);
  return out;
}

const CONFIG = {
  clientId:     'docflow-client-160',
  kid:          'kid-160',
  privateKeyPem: FAKE_KEY,
  redirectUri:  'https://staging.example.ro/flows/sts-oauth-callback',
  idpUrl:       'https://idp.example.ro',
  apiUrl:       'https://sign.example.ro',
};

async function makeSession() {
  const provider = new STSCloudProvider();
  return provider.initiateSession({
    flowId:  'PMX_TEST160',
    signer:  { email: 'semnatar@example.ro', token: 'tok-160' },
    pdfBytes: Buffer.from('%PDF-1.7 test'),
    flowData: { docName: 'Contract.pdf' },
    config:   CONFIG,
    appBaseUrl: 'https://staging.example.ro',
    padesHashBase64: 'aGFzaC1kZS10ZXN0',
  });
}

describe('#160 — cheia privată STS nu se mai persistă în starea sesiunii', () => {
  it('initiateSession() nu pune cheia în providerData, la nicio adâncime', async () => {
    const session = await makeSession();
    const leaked = findKeys(session.providerData, ['privateKeyPem', 'signingKeyPem', 'keyPem']);
    expect(leaked, `chei scurse: ${leaked.join(', ')}`).toEqual([]);
    // nici măcar ca valoare, sub alt nume de câmp
    const strings = collectStrings(session.providerData);
    expect(strings.some(s => s.includes(PEM_MARKER))).toBe(false);
    expect(strings.some(s => s.includes(FAKE_KEY))).toBe(false);
    // și nici în restul obiectului de sesiune
    expect(collectStrings(session).some(s => s.includes(PEM_MARKER))).toBe(false);
  });

  it('providerData păstrează câmpurile de care depinde restul fluxului', async () => {
    const { providerData: pd } = await makeSession();
    expect(pd.codeVerifier).toBeTruthy();
    expect(pd.codeChallenge).toBeTruthy();
    expect(pd.state).toBeTruthy();
    expect(pd.nonce).toBeTruthy();
    expect(pd.clientId).toBe(CONFIG.clientId);
    expect(pd.kid).toBe(CONFIG.kid);
    expect(pd.redirectUri).toBe(CONFIG.redirectUri);
    expect(pd.idpUrl).toBe(CONFIG.idpUrl);
    expect(pd.signUrl).toBe(CONFIG.apiUrl);
  });

  it('signingUrl OAuth nu s-a degradat (code_challenge + state + redirect_uri)', async () => {
    const session = await makeSession();
    const url = new URL(session.signingUrl);
    expect(url.searchParams.get('code_challenge')).toBe(session.providerData.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(`${session.sessionId}___${session.providerData.state}`);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
  });

  describe('exchangeCodeForToken — fail-closed fără cheie', () => {
    let fetchSpy;
    beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('fără al treilea parametru ⇒ sts_key_missing, fără niciun apel de rețea', async () => {
      const provider = new STSCloudProvider();
      const session = await makeSession();
      expect(fetchSpy).toHaveBeenCalledTimes(0); // initiateSession nu face rețea
      const r = await provider.exchangeCodeForToken('the-code', session);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('sts_key_missing');
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });
  });
});

describe('#160 — analiză statică: apelanții transmit cheia explicit', () => {
  const cloud = readFileSync(path.join(REPO, 'server/routes/flows/cloud-signing.mjs'), 'utf8');
  const bulk  = readFileSync(path.join(REPO, 'server/routes/flows/bulk-signing.mjs'), 'utf8');
  const prov  = readFileSync(path.join(REPO, 'server/signing/providers/STSCloudProvider.mjs'), 'utf8');

  it('initiateSession nu mai copiază config.privateKeyPem în providerData', () => {
    expect(prov).not.toMatch(/privateKeyPem:\s*config\.privateKeyPem/);
  });

  it('exchangeCodeForToken are al treilea parametru', () => {
    expect(prov).toMatch(/async exchangeCodeForToken\(\s*code,\s*session,\s*signingKeyPem\s*\)/);
  });

  it('cloud-signing apelează exchangeCodeForToken cu 3 argumente', () => {
    expect(cloud).toMatch(
      /exchangeCodeForToken\(\s*code,\s*session,\s*_stsConfig\.privateKeyPem\s*\)/);
  });

  it('bulk-signing apelează exchangeCodeForToken cu 3 argumente', () => {
    expect(bulk).toMatch(
      /exchangeCodeForToken\([\s\S]{0,200}?_bulkConfig\.privateKeyPem\s*\)/);
  });

  it('bulk-signing nu mai scrie cheia în INSERT-ul sesiunii', () => {
    expect(bulk).not.toMatch(/privateKeyPem:\s*providerConfig\.privateKeyPem/);
    // INSERT-ul în bulk_signing_sessions nu conține deloc privateKeyPem
    const insertIdx = bulk.indexOf('INSERT INTO bulk_signing_sessions');
    expect(insertIdx).toBeGreaterThan(-1);
    const insertBlock = bulk.slice(insertIdx, insertIdx + 900);
    expect(insertBlock).not.toContain('privateKeyPem');
  });
});
