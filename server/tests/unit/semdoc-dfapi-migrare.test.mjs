// @vitest-environment happy-dom
/**
 * #189 — paginile de semnare migrate pe sursa unică `window.DFApi` (etapa 3/4):
 * `public/js/semdoc-initiator/` și `public/js/semdoc-signer/`.
 *
 * Migrarea e mecanică (`fetch(` → `DFApi.fetch(`, `credentials` șters, `'X-CSRF-Token'`
 * șters din call-site), dar ecranul de semnare e calea vie prin care se produc semnăturile
 * QES: o regresie aici nu strică un badge, ci oprește semnarea. Testele apără cele trei
 * capcane identificate ÎNAINTE de migrare + decizia deliberată de a NU migra auth-guard.js:
 *
 *   C1 — corp `FormData` FĂRĂ `Content-Type` (POST /api/convert-to-pdf). Antetul trebuie să
 *        rămână ABSENT: browserul îl generează singur, cu `boundary`. Orice `Content-Type`
 *        adăugat de DFApi ar rupe tăcut încărcarea fișierelor de convertit.
 *   C2 — răspunsuri binare pe calea de semnare (8 locuri fac `.blob()` / `.arrayBuffer()`
 *        prin `_apiFetch`): `DFApi.fetch` trebuie să întoarcă `Response` BRUT.
 *   C3 — antetul CSRF dublat: call-site-ul îl scria cu MAJUSCULE, `DFApi.fetch` îl pune cu
 *        minuscule; `Headers` normalizează cheia și CONCATENEAZĂ valorile cu virgulă ⇒
 *        token `abc,abc` ⇒ 403 ⇒ retry ⇒ „uneori merge, alteori nu". (Apelul `df.getCsrf()`
 *        neprefixat a fost chiar defectul reparat la #188; după migrare nu mai există.)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '../../../public');
const DIRS = ['js/semdoc-initiator', 'js/semdoc-signer'];

/** Toate fișierele .js din cele două module, cheiate pe cale relativă la public/js. */
const SRC = {};
for (const d of DIRS) {
  for (const f of readdirSync(join(PUBLIC, d)).filter(x => x.endsWith('.js')).sort()) {
    SRC[`${d.replace('js/', '')}/${f}`] = readFileSync(join(PUBLIC, d, f), 'utf8');
  }
}
const FILES = Object.keys(SRC).sort();

/** Scoate comentariile, ca numărătoarea să se facă pe COD, nu pe proză. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `fetch(` global — nici `DFApi.fetch(`, nici `_apiFetch(` (F majuscul, nu se potrivește). */
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/g;
const DFAPI_FETCH = /DFApi\.fetch\s*\(/g;
const count = (s, re) => (s.match(re) || []).length;

/** Argumentele fiecărui `DFApi.fetch(...)`, decupate pe paranteze echilibrate. */
function dfApiCallArgs(src) {
  const out = [];
  const re = /DFApi\.fetch\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

// ── 1-4: analiză statică ─────────────────────────────────────────────────────

describe('#189 — analiză statică pe semdoc-initiator/ și semdoc-signer/', () => {
  it('1. C3: zero „X-CSRF-Token" scris de mână, în ambele module', () => {
    expect(FILES.filter(f => /X-CSRF-Token/i.test(SRC[f]))).toEqual([]);
  });

  it('2. zero „credentials:" rămas ÎN call-site-urile migrate (DFApi îl impune)', () => {
    // Scopat pe argumentele apelurilor DFApi.fetch — restul fișierului are voie să
    // conțină `credentials` (apeluri `_apiFetch` nemigrate, comentarii, auth-guard.js).
    const vinovate = [];
    for (const f of FILES) {
      for (const args of dfApiCallArgs(stripComments(SRC[f]))) {
        if (/credentials\s*:/.test(args)) vinovate.push(f);
      }
    }
    expect(vinovate).toEqual([]);
  });

  it('3. auth-guard.js rămâne DELIBERAT pe fetch brut — se încarcă înaintea df-api.js', () => {
    // Nu e o scăpare a migrării, e o decizie: garda se încarcă la linia 14 din
    // semdoc-signer.html, iar df-api.js abia la 17. Mutarea ei după ar întârzia redirectul
    // vizitatorului nelogat, iar DFApi fără cârlige n-ar aduce nimic pe un GET /auth/me.
    // Testul există ca un lot viitor să nu o migreze din reflex.
    const cod = stripComments(SRC['semdoc-signer/auth-guard.js']);
    expect(count(cod, BARE_FETCH)).toBe(1);
    expect(cod).not.toMatch(/DFApi/);
    // Iar motivul e scris în fișier, nu doar aici.
    expect(SRC['semdoc-signer/auth-guard.js']).toMatch(/#189/);
  });

  it('4. fiecare apel de rețea e migrat, în afara excepției documentate', () => {
    // Cifrele se DERIVĂ din fișiere, pe fișierul ÎNTREG, nu dintr-un grep îngust.
    const bare = {};
    const dfapi = {};
    for (const f of FILES) {
      const cod = stripComments(SRC[f]);
      bare[f] = count(cod, BARE_FETCH);
      dfapi[f] = count(cod, DFAPI_FETCH);
    }
    // Singurul `fetch(` brut rămas în tot cele două module e garda de la cazul 3.
    expect(bare).toEqual(Object.fromEntries(
      FILES.map(f => [f, f === 'semdoc-signer/auth-guard.js' ? 1 : 0])));
    // Plasă împotriva unui „fix" care ar ȘTERGE apelurile în loc să le migreze:
    // opt call-site-uri migrate, distribuite exact așa.
    expect(dfapi).toEqual({
      'semdoc-initiator/main.js': 5,
      'semdoc-initiator/modals.js': 0,
      'semdoc-signer/auth-guard.js': 0,
      'semdoc-signer/main.js': 2,
      'semdoc-signer/modals.js': 1,
      'semdoc-signer/post-dom-handlers.js': 0,
    });
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

describe('#189 — DFApi.fetch pe apelurile migrate din semdoc-*', () => {
  it('5. C1: corp FormData FĂRĂ Content-Type ajunge la rețea tot fără Content-Type', async () => {
    const calls = installFetch(() => new Response('{}', { status: 200 }));
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-CONVERT');

    // Forma exactă a conversiei non-PDF după migrare (semdoc-initiator/main.js:317):
    // niciun antet declarat de apelant — browserul pune multipart/form-data; boundary=…
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'contract.docx');
    await DFApi.fetch('/api/convert-to-pdf', { method: 'POST', body: fd });

    const [c] = appCalls(calls);
    const ctKeys = Object.keys(c.opts.headers).filter(k => k.toLowerCase() === 'content-type');
    expect(ctKeys).toEqual([]);              // ABSENT rămâne ABSENT — boundary-ul se păstrează
    expect(c.opts.body).toBe(fd);            // corpul e trimis ca atare, nu re-serializat
    expect(c.opts.headers['x-csrf-token']).toBe('CSRF-CONVERT'); // dar CSRF-ul tot se pune
  });

  it('6. C2: întoarce Response BRUT — .blob() și .arrayBuffer() dau exact octeții trimiși', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]); // %PDF-1.7
    installFetch(() => new Response(new Blob([bytes], { type: 'application/pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'X-Docflow-UploadToken': 'tok-42' },
    }));
    const DFApi = loadFresh();
    await flush();

    // Descărcarea PDF-ului nesemnat din ecranul semnatarului.
    const r1 = await DFApi.fetch('/flows/abc/pdf?token=xyz');
    expect(r1.headers.get('content-type')).toBe('application/pdf');
    // Antetele proprii ale rutei de semnare supraviețuiesc (buildCartusBlob citește tokenul).
    expect(r1.headers.get('X-Docflow-UploadToken')).toBe('tok-42');
    expect(new Uint8Array(await (await r1.blob()).arrayBuffer())).toEqual(bytes);

    // Aceeași cale, citită ca arrayBuffer (hash-ul SHA-256 trimis la STS).
    const r2 = await DFApi.fetch('/flows/abc/signed-pdf?token=xyz');
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(bytes);
  });

  it('7. C3: o mutație migrată ajunge la rețea cu EXACT un antet CSRF', async () => {
    const calls = installFetch(() => new Response('{}', { status: 200 }));
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-UNIC');

    // Forma exactă a legării ALOP după migrare (semdoc-initiator/main.js:2530):
    // fără antet CSRF și fără df.getCsrf() în call-site.
    await DFApi.fetch('/api/alop/7/link-df-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: 'f1' }),
    });

    const [c] = appCalls(calls);
    const csrfKeys = Object.keys(c.opts.headers).filter(k => k.toLowerCase() === 'x-csrf-token');
    expect(csrfKeys).toEqual(['x-csrf-token']);
    expect(c.opts.headers['x-csrf-token']).toBe('CSRF-UNIC');
    // Dovada că un call-site care ar PĂSTRA antetul cu majuscule ar dubla valoarea:
    const dublat = new Headers();
    dublat.append('X-CSRF-Token', 'CSRF-UNIC');
    dublat.append('x-csrf-token', 'CSRF-UNIC');
    expect(dublat.get('x-csrf-token')).toContain(',');
  });
});
