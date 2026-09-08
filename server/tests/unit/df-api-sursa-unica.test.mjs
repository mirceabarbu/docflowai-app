// @vitest-environment happy-dom
/**
 * #183 — sursa unică de acces la API din frontend: public/js/shared/df-api.js.
 *
 * Frontendul avea CINCI implementări de apiFetch, dintre care trei divergeau semantic de
 * canonica: aceasta ȘTERGE antetul `Authorization`, iar shim-urile îl ADĂUGAU din
 * `localStorage.docflow_token`. Testele de mai jos fixează comportamentul canonic, ca
 * nimeni să nu „repare" prin reintroducerea Bearer-ului (cazul 3).
 *
 * df-api.js e script CLASIC (fără `type="module"`), deci nu se poate `import`-a: e evaluat
 * cu `new Function(src)` peste DOM-ul happy-dom, exact ca în pagin-component.test.mjs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// happy-dom substituie global.URL cu propria implementare, care nu acceptă
// `new URL('.', import.meta.url)` — rezolvăm calea cu fileURLToPath pe string.
const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '../../../public');
const SRC = readFileSync(join(PUBLIC, 'js/shared/df-api.js'), 'utf8');

// ── Harness ──────────────────────────────────────────────────────────────────

/** Răspuns minimal compatibil cu ce folosește df-api.js: status, ok, clone().json(). */
function mkRes(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    clone: () => ({ json: async () => body }),
  };
}

/** Instalează un fetch fals care întoarce, pe rând, răspunsurile din `queue`. */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    const r = await handler(url, opts, calls.length);
    return r || mkRes(200, {});
  });
  return calls;
}

/** Reîncarcă df-api.js curat (șterge garda de reintrare) și întoarce window.DFApi. */
function loadFresh() {
  delete globalThis.window.DFApi;
  globalThis.window._csrfToken = null;
  new Function(SRC).call(globalThis);
  return globalThis.window.DFApi;
}

/** Lasă microtask-urile în zbor (initCsrf) să se stingă. */
const flush = () => new Promise(r => setTimeout(r, 0));

/** Apelurile care NU sunt prefetch-ul de CSRF făcut de initCsrf. */
const appCalls = calls => calls.filter(c => c.url !== '/auth/csrf-token');

beforeEach(() => {
  globalThis.localStorage.clear();
  vi.restoreAllMocks();
});

// ── 1-3: antete ──────────────────────────────────────────────────────────────

describe('DFApi.fetch — antete', () => {
  it('1. GET nu trimite x-csrf-token; o mutație îl trimite', async () => {
    const calls = installFetch(() => mkRes(200, {}));
    const DFApi = loadFresh();
    // initCsrf (async, la încărcare) suprascrie window._csrfToken cu ce întoarce serverul —
    // comportament preluat verbatim din core.js/shim-full.js. Îl lăsăm să se stingă întâi.
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-123');

    await DFApi.fetch('/api/x');
    await DFApi.fetch('/api/x', { method: 'POST' });

    const [get, post] = appCalls(calls);
    expect(get.opts.headers['x-csrf-token']).toBeUndefined();
    expect(post.opts.headers['x-csrf-token']).toBe('CSRF-123');
  });

  it('2. credentials: "include" pe fiecare apel', async () => {
    const calls = installFetch(() => mkRes(200, {}));
    const DFApi = loadFresh();

    await DFApi.fetch('/api/a');
    await DFApi.fetch('/api/b', { method: 'PUT', credentials: 'omit' });
    await flush();

    for (const c of calls) expect(c.opts.credentials).toBe('include');
  });

  it('3. ⭐ Authorization e ȘTERS, chiar dacă apelantul îl pune explicit ȘI localStorage are docflow_token', async () => {
    globalThis.localStorage.setItem('docflow_token', 'TOKEN-LEGACY');
    const calls = installFetch(() => mkRes(200, {}));
    const DFApi = loadFresh();

    await DFApi.fetch('/api/x', { headers: { Authorization: 'Bearer AAA', 'X-Keep': '1' } });
    // și varianta cu literă mică — un call-site migrat în loturile 2-4 ar putea folosi asta
    await DFApi.fetch('/api/y', { headers: { authorization: 'Bearer BBB' } });
    await flush();

    const [a, b] = appCalls(calls);
    const keys = h => Object.keys(h).map(k => k.toLowerCase());
    expect(keys(a.opts.headers)).not.toContain('authorization');
    expect(a.opts.headers['X-Keep']).toBe('1'); // restul antetelor rămân neatinse
    expect(keys(b.opts.headers)).not.toContain('authorization');

    // Niciun apel nu a citit token-ul legacy înapoi în vreo formă.
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('TOKEN-LEGACY');
  });
});

// ── 4: retry CSRF ────────────────────────────────────────────────────────────

describe('DFApi.fetch — 403 csrf_invalid', () => {
  it('4. cere token nou și reîncearcă O SINGURĂ dată; al doilea 403 nu produce buclă', async () => {
    const calls = installFetch(async (url) => {
      if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'CSRF-NOU' });
      return mkRes(403, { error: 'csrf_invalid' }); // mereu 403
    });
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi.setCsrf('CSRF-VECHI');

    const res = await DFApi.fetch('/api/x', { method: 'POST' });

    expect(res.status).toBe(403); // se întoarce, nu aruncă
    const mutations = calls.filter(c => c.url === '/api/x');
    expect(mutations).toHaveLength(2); // original + exact un retry
    expect(mutations[0].opts.headers['x-csrf-token']).toBe('CSRF-VECHI');
    expect(mutations[1].opts.headers['x-csrf-token']).toBe('CSRF-NOU');
    expect(calls.filter(c => c.url === '/auth/csrf-token')).toHaveLength(1);
  });
});

// ── 5-7: 401 și cârligele ────────────────────────────────────────────────────

describe('DFApi.fetch — 401 și cârligele opționale', () => {
  it('5. fără cârlige, un 401 se întoarce BRUT: fără excepție, fără redirect, fără refresh', async () => {
    const calls = installFetch(async (url) => {
      if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'C' });
      return mkRes(401, { error: 'token_invalid_or_expired' });
    });
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;

    const res = await DFApi.fetch('/api/x');

    expect(res.status).toBe(401);
    expect(calls.filter(c => c.url === '/api/x')).toHaveLength(1); // niciun retry
  });

  it('6. cu cârlig de refresh care întoarce true, apelul se reia', async () => {
    let n = 0;
    const calls = installFetch(async (url) => {
      if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'C' });
      n++;
      return n === 1 ? mkRes(401, { error: 'token_invalid_or_expired' }) : mkRes(200, { ok: true });
    });
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;

    const refresh = vi.fn(async () => true);
    DFApi._setRefreshHook(refresh);

    const res = await DFApi.fetch('/api/x');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(calls.filter(c => c.url === '/api/x')).toHaveLength(2);
  });

  it('6b. cârlig de refresh care întoarce false: răspunsul 401 rămâne, fără retry', async () => {
    const calls = installFetch(async (url) => {
      if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'C' });
      return mkRes(401, { error: 'unauthorized' });
    });
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;
    DFApi._setRefreshHook(async () => false);

    const res = await DFApi.fetch('/api/x');
    expect(res.status).toBe(401);
    expect(calls.filter(c => c.url === '/api/x')).toHaveLength(1);
  });

  it('7. ⭐ cod din REVOKED_CODES la 401 ⇒ redirect chemat, refresh NU', async () => {
    for (const code of ['session_revoked', 'token_revoked', 'session_role_stale', 'session_org_stale']) {
      const calls = installFetch(async (url) => {
        if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'C' });
        return mkRes(401, { error: code });
      });
      const DFApi = loadFresh();
      await flush();
      calls.length = 0;

      const refresh = vi.fn(async () => true);
      const redirect = vi.fn();
      DFApi._setRefreshHook(refresh);
      DFApi._setRedirectHook(redirect);

      const res = await DFApi.fetch('/api/x');

      expect(redirect, code).toHaveBeenCalledTimes(1);
      expect(refresh, code).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      expect(calls.filter(c => c.url === '/api/x')).toHaveLength(1);
    }
  });

  it('7b. fără refresh dar CU redirect (bulk-signer), orice 401 redirectează — comportament păstrat', async () => {
    const calls = installFetch(async (url) => {
      if (url === '/auth/csrf-token') return mkRes(200, { csrfToken: 'C' });
      return mkRes(401, { error: 'unauthorized' });
    });
    const DFApi = loadFresh();
    await flush();
    calls.length = 0;

    const redirect = vi.fn();
    DFApi._setRedirectHook(redirect);

    await DFApi.fetch('/api/x');
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

// ── 8: garda de reintrare ────────────────────────────────────────────────────

describe('df-api.js — garda de reintrare', () => {
  it('8. inclus de două ori, nu dublează initCsrf și nu resetează cârligele', async () => {
    const calls = installFetch(async () => mkRes(200, { csrfToken: 'C' }));
    const DFApi = loadFresh();
    await flush();

    const redirect = vi.fn();
    DFApi._setRedirectHook(redirect);
    const csrfCallsAfterFirst = calls.filter(c => c.url === '/auth/csrf-token').length;
    expect(csrfCallsAfterFirst).toBe(1);

    // A doua includere (fără loadFresh — garda trebuie să o oprească).
    new Function(SRC).call(globalThis);
    await flush();

    expect(calls.filter(c => c.url === '/auth/csrf-token')).toHaveLength(1);
    expect(globalThis.window.DFApi).toBe(DFApi); // aceeași instanță, cârligele intacte
  });
});

// ── 9-11: analiză statică ────────────────────────────────────────────────────

describe('#183 — convergența celor cinci puncte de intrare (analiză statică)', () => {
  const CONVERGED = [
    'js/admin/core.js',
    'js/df-apifetch-shim.js',
    'js/df-apifetch-shim-full.js',
    'js/bulk-signer/bulk-signer.js',
  ];

  // Aserțiunile țintesc FORMA DE COD, nu prezența cuvântului: fișierele explică în
  // comentarii de ce a dispărut fallback-ul, iar un `not.toMatch(/docflow_token/)` brut
  // ar pica pe propria documentație.
  it('9. niciunul dintre cele patru fișiere nu mai citește localStorage.docflow_token', () => {
    for (const rel of CONVERGED) {
      const src = readFileSync(join(PUBLIC, rel), 'utf8');
      expect(src, rel).not.toMatch(/getItem\(\s*['"]docflow_token['"]\s*\)/);
      expect(src, rel).not.toMatch(/headers\[\s*['"][Aa]uthorization['"]\s*\]\s*=/);
      expect(src, rel).not.toMatch(/['"]Bearer\s/);
    }
  });

  it('9b. cele patru deleagă la window.DFApi.fetch', () => {
    for (const rel of CONVERGED) {
      const src = readFileSync(join(PUBLIC, rel), 'utf8');
      expect(src, rel).toMatch(/window\.DFApi\.fetch\(/);
    }
  });

  it('10. notif-widget.js nu mai are o a doua definiție de apiFetch cu corp propriu', () => {
    const src = readFileSync(join(PUBLIC, 'notif-widget.js'), 'utf8');
    // Delegarea e singurul corp acceptat.
    expect(src).toMatch(/function apiFetch\(url, options = \{\}\) \{\s*return window\.DFApi\.fetch\(url, options\);\s*\}/);
    // Semnele implementării proprii au dispărut (forma de cod, nu cuvântul din comentarii).
    expect(src).not.toMatch(/delete headers\['Authorization'\]/);
    expect(src).not.toMatch(/error === ['"]csrf_invalid['"]/);
    expect(src).not.toMatch(/x-csrf-token/);
    expect(src).not.toMatch(/const REVOKED_CODES/);
    // Contractul public rămâne expus, cu același nume.
    expect(src).toMatch(/window\.docflow\.apiFetch = apiFetch;/);
    expect(src).toMatch(/window\.docflow\.showToast = showToast;/);
  });

  it('11. ⭐ orice pagină care încarcă un consumator încarcă df-api.js ÎNAINTEA lui', () => {
    // Lista se derivă din fișiere, NU e scrisă de mână — testul trebuie să cadă
    // dacă apare o pagină nouă care uită sursa unică.
    const CONSUMERS = [
      'notif-widget.js',
      'df-apifetch-shim.js',
      'df-apifetch-shim-full.js',
      '/js/admin/core.js',
      'bulk-signer/bulk-signer.js',
    ];
    const pages = readdirSync(PUBLIC).filter(f => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(10);

    let checked = 0;
    for (const page of pages) {
      const html = readFileSync(join(PUBLIC, page), 'utf8');
      const scriptTags = html.match(/<script\b[^>]*src=[^>]*>/g) || [];
      const firstConsumer = scriptTags.findIndex(t => CONSUMERS.some(c => t.includes(c)));
      if (firstConsumer < 0) continue;
      checked++;

      const apiIdx = scriptTags.findIndex(t => t.includes('/js/shared/df-api.js'));
      expect(apiIdx, `${page}: nu încarcă /js/shared/df-api.js`).toBeGreaterThanOrEqual(0);
      expect(apiIdx, `${page}: df-api.js e încărcat DUPĂ ${scriptTags[firstConsumer]}`)
        .toBeLessThan(firstConsumer);
    }
    // Sanity: chiar am verificat paginile reale, nu am sărit peste toate.
    expect(checked).toBe(13);
  });

  it('11b. df-api.js e pre-cache-uit în service worker (notif-widget.js e, iar depinde de el)', () => {
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    const precache = sw.slice(sw.indexOf('PRECACHE_ASSETS'), sw.indexOf('];', sw.indexOf('PRECACHE_ASSETS')));
    expect(precache).toContain("'/js/shared/df-api.js'");
    expect(precache).toContain("'/notif-widget.js'");
  });
});
