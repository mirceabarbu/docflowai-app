// @vitest-environment happy-dom
/**
 * #184 — modulul `public/js/formular/` migrat pe sursa unică `window.DFApi` (etapa 2/4).
 *
 * Migrarea e mecanică (trei transformări: `fetch(` → `DFApi.fetch(`, `credentials:'include'`
 * șters, `'X-CSRF-Token'` șters din call-site). Testele de mai jos apără cele patru capcane
 * identificate ÎNAINTE de migrare, ca nimeni să nu le reintroducă „pentru siguranță":
 *
 *   C1 — antetul CSRF dublat. Call-site-urile îl scriau cu MAJUSCULE, `DFApi.fetch` îl pune cu
 *        minuscule. `Headers` normalizează cheile și CONCATENEAZĂ valorile duplicate cu virgulă
 *        ⇒ token `abc,abc` ⇒ 403 `csrf_invalid` ⇒ retry ⇒ „uneori salvează, alteori nu".
 *   C2 — corpuri binare (capturi, atașamente): `Content-Type: image/png` + `X-Filename` trebuie
 *        să ajungă la rețea NESCHIMBATE.
 *   C3 — răspunsuri binare: `DFApi.fetch` trebuie să întoarcă `Response` BRUT (7 call-site-uri
 *        fac `.blob()` pe el), nu JSON deja parsat.
 *   C4 — `verif.js` era ultimul loc din modul care trimitea `Authorization: Bearer` din
 *        `localStorage` (chei MOARTE: `docflow_token` și `jwt`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '../../../public');
const FORMULAR_DIR = join(PUBLIC, 'js/formular');

const FILES = readdirSync(FORMULAR_DIR).filter(f => f.endsWith('.js')).sort();
const SRC = Object.fromEntries(FILES.map(f => [f, readFileSync(join(FORMULAR_DIR, f), 'utf8')]));

/**
 * Scoate comentariile, ca numărătoarea de apeluri să se facă pe COD, nu pe proză.
 * `//` se ignoră când e precedat de `:` (`https://`) — singurul fals pozitiv realist aici.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `fetch(` care NU e nici `DFApi.fetch(`, nici un helper local gen `_fetch(`. */
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/g;
const DFAPI_FETCH = /DFApi\.fetch\s*\(/g;
const count = (s, re) => (s.match(re) || []).length;

// ── 1-4: analiză statică pe fișierele migrate ────────────────────────────────

describe('#184 — analiză statică pe public/js/formular/', () => {
  it('1. C1: zero „X-CSRF-Token" scris de mână în call-site-uri', () => {
    const vinovate = FILES.filter(f => /X-CSRF-Token/i.test(SRC[f]));
    expect(vinovate).toEqual([]);
  });

  it('2. zero „credentials:" rămas în call-site-uri (DFApi îl impune)', () => {
    const vinovate = FILES.filter(f => /credentials\s*:/.test(SRC[f]));
    expect(vinovate).toEqual([]);
  });

  it('3. C4: zero citiri de token din localStorage (docflow_token / jwt)', () => {
    const vinovate = FILES.filter(f =>
      /docflow_token/.test(SRC[f]) || /getItem\(\s*['"]jwt['"]\s*\)/.test(SRC[f]));
    expect(vinovate).toEqual([]);
  });

  it('4. niciun apel de rețea nu a rămas pe `fetch()` brut, în niciun fișier', () => {
    // Cifrele se DERIVĂ din fișier (nu sunt scrise de mână) și se numără pe fișierul
    // ÎNTREG, nu pe un grep îngust: fiecare `fetch(` din cod e sau `DFApi.fetch(`,
    // sau un helper local (`_fetch(`), niciodată apelul global.
    const raport = {};
    for (const f of FILES) {
      const cod = stripComments(SRC[f]);
      raport[f] = { bare: count(cod, BARE_FETCH), dfapi: count(cod, DFAPI_FETCH) };
    }
    expect(Object.fromEntries(Object.entries(raport).map(([f, r]) => [f, r.bare])))
      .toEqual(Object.fromEntries(FILES.map(f => [f, 0])));

    // Plasă împotriva unui „fix" care ar șterge apelurile în loc să le migreze.
    const total = Object.values(raport).reduce((s, r) => s + r.dfapi, 0);
    expect(total).toBeGreaterThanOrEqual(70);
  });
});

// ── 5-7: comportament, pe df-api.js REAL ─────────────────────────────────────

const DFAPI_SRC = readFileSync(join(PUBLIC, 'js/shared/df-api.js'), 'utf8');

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return (await handler(url, opts, calls.length)) || new Response('{}', { status: 200 });
  });
  return calls;
}

function loadFresh() {
  delete globalThis.window.DFApi;
  globalThis.window._csrfToken = null;
  new Function(DFAPI_SRC).call(globalThis);
  return globalThis.window.DFApi;
}

const flush = () => new Promise(r => setTimeout(r, 0));
const appCalls = calls => calls.filter(c => c.url !== '/auth/csrf-token');

beforeEach(() => {
  globalThis.localStorage.clear();
  vi.restoreAllMocks();
});

describe('#184 — DFApi.fetch pe apelurile migrate din formular/', () => {
  it('5. C2: corp binar — Content-Type și X-Filename ajung la rețea nemodificate', async () => {
    const calls = installFetch(() => new Response('{}', { status: 200 }));
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-CAPTURA');

    // Forma exactă a lui uploadCaptura() după migrare (doc.js).
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    await DFApi.fetch('/api/formulare-capturi/ord/42?slot=1', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Filename': 'captura_ordnt_1.png' },
      body: blob,
    });

    const [c] = appCalls(calls);
    expect(c.opts.headers['Content-Type']).toBe('image/png');
    expect(c.opts.headers['X-Filename']).toBe('captura_ordnt_1.png');
    // DFApi NU forțează application/json peste tipul apelantului.
    expect(JSON.stringify(c.opts.headers)).not.toMatch(/application\/json/);
    expect(c.opts.body).toBe(blob);
  });

  it('6. C3: întoarce Response BRUT — se poate chema .blob() pe el', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]); // %PDF
    installFetch(() => new Response(new Blob([bytes], { type: 'application/pdf' }),
      { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const DFApi = loadFresh();
    await flush();

    const r = await DFApi.fetch('/flows/abc/signed-pdf');
    expect(typeof r.blob).toBe('function');
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const b = await r.blob();
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(bytes);
  });

  it('7. C1: o mutație migrată ajunge la rețea cu EXACT un antet CSRF', async () => {
    const calls = installFetch(() => new Response('{}', { status: 200 }));
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-UNIC');

    // Forma exactă a lui saveDoc() după migrare (doc.js): fără antet CSRF în call-site.
    await DFApi.fetch('/api/formulare-df/7', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });

    const [c] = appCalls(calls);
    const csrfKeys = Object.keys(c.opts.headers).filter(k => k.toLowerCase() === 'x-csrf-token');
    expect(csrfKeys).toEqual(['x-csrf-token']);
    expect(c.opts.headers['x-csrf-token']).toBe('CSRF-UNIC');
    // Dovada că un call-site care ar PĂSTRA antetul cu majuscule ar produce valoarea dublată:
    // `Headers` normalizează cheia și CONCATENEAZĂ valorile, exact ca în browser.
    const dublat = new Headers();
    dublat.append('X-CSRF-Token', 'CSRF-UNIC');
    dublat.append('x-csrf-token', 'CSRF-UNIC');
    expect(dublat.get('x-csrf-token')).toContain(',');
  });
});
