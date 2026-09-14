// @vitest-environment happy-dom
/**
 * #205 — `DFApi.json(res)`: gardă pe content-type pentru call-site-uri.
 *
 * Un răspuns de proxy („upstream error", text/plain) nu e JSON. Fără gardă, `res.json()`
 * aruncă `SyntaxError: Unexpected token 'u', "upstream error" is not valid JSON` — exact
 * textul pe care l-a văzut utilizatorul pe ecran. Helper-ul aruncă în schimb o eroare cu
 * `nonJson = true` + `httpStatus`, cu mesaj util.
 *
 * ⛔ `res.clone().json()`-urile INTERNE din dfFetch rămân separate (alt scop) — testul de
 * mai jos NU le atinge și nu afirmă nimic despre ele.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, '../../../public/js/shared/df-api.js'), 'utf8');

function loadFresh() {
  delete globalThis.window.DFApi;
  globalThis.window._csrfToken = null;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  new Function(SRC).call(globalThis);
  return globalThis.window.DFApi;
}

/** Răspuns minimal: headers.get + json() care se comportă ca fetch-ul real. */
function mkRes(status, contentType, bodyText) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => JSON.parse(bodyText),
  };
}

describe('#205 — DFApi.json() gardă content-type', () => {
  it('este expus pe DFApi ca funcție', () => {
    const DFApi = loadFresh();
    expect(typeof DFApi.json).toBe('function');
  });

  it('text/plain „upstream error" ⇒ aruncă cu nonJson=true + httpStatus, NU SyntaxError', async () => {
    const DFApi = loadFresh();
    const res = mkRes(502, 'text/plain; charset=utf-8', 'upstream error');
    let caught = null;
    try { await DFApi.json(res); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect(caught.nonJson).toBe(true);
    expect(caught.httpStatus).toBe(502);
    expect(caught.message).toMatch(/Serverul nu a răspuns corect/);
    // Controlul: res.json() brut pe același corp CHIAR aruncă SyntaxError.
    await expect(res.json()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('content-type lipsă ⇒ tratat ca non-JSON (nu se încearcă parsarea)', async () => {
    const DFApi = loadFresh();
    const res = mkRes(200, null, 'upstream error');
    await expect(DFApi.json(res)).rejects.toMatchObject({ nonJson: true, httpStatus: 200 });
  });

  it('application/json ⇒ parsează normal (inclusiv cu charset în content-type)', async () => {
    const DFApi = loadFresh();
    const res = mkRes(200, 'Application/JSON; charset=utf-8', '{"ok":true,"captura":{"id":7}}');
    await expect(DFApi.json(res)).resolves.toEqual({ ok: true, captura: { id: 7 } });
  });

  it('application/json cu status de eroare ⇒ tot parsează (corpul de eroare e util apelantului)', async () => {
    const DFApi = loadFresh();
    const res = mkRes(413, 'application/json', '{"error":"fisier_prea_mare"}');
    await expect(DFApi.json(res)).resolves.toEqual({ error: 'fisier_prea_mare' });
  });
});
