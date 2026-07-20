---
fix(perf+ops): flood CSP Report-Only (style-src-attr) — cauza confirmată a încărcării lente pe staging
target_branch: develop
model_suggested: Opus 4.8 (atinge headere de securitate — precizie, nu doar performanță)
risk: SCĂZUT (doar restrânge un header report-only + adaugă dedup la logging; NU atinge politica de enforcement)
version: 3.9.610 → 3.9.611
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (CONFIRMATĂ din logs Railway, captură atașată)
Logurile arată 4+ rapoarte `csp-violation` distincte în ACEEAȘI secundă (09:32:43.344–345Z),
toate `violated-directive: style-src-attr`, la linii diferite din pagină. Politica
`Content-Security-Policy-Report-Only` (v3.9.585, fază de vizibilitate pentru eliminarea
`unsafe-inline`) e mult mai strictă decât politica reală de enforcement (`style-src 'self'`
fără `unsafe-inline`, `script-src-attr 'none'`), dar codul folosește masiv `style="..."` inline
(comentariul din `index.mjs` confirmă „130+ handlere inline" — tech debt cunoscut, netratat încă).

**Efect:** fiecare încărcare de pagină declanșează ZECI de POST-uri simultane ale browserului
către `/api/csp-report`, concurente cu request-urile reale de date pe limita de conexiuni
per-origine a browserului (~6) → percepție de „pagină foarte lentă". Posibil efect secundar:
volumul de parsare JSON + logging sincron poate contribui la întârzieri pe alte operații async
(login, signing-providers, archive job) — NU confirmat cu certitudine, vezi Partea C.

# 🚫 NO-TOUCH
Politica de ENFORCEMENT (`contentSecurityPolicy: { directives: {...} }`, liniile ~546-561, cea
cu `helmet`) — NU o atinge, rămâne exact cum e. Modifici DOAR header-ul `Report-Only` (fază de
vizibilitate, nu blochează nimic) și handler-ul `/api/csp-report`. Semnare, financiar ALOP —
neatinse (evident, dar de menționat).

# Etapa 0 — caracterizare
```bash
sed -n '576,600p' server/index.mjs
sed -n '1784,1806p' server/index.mjs
grep -n "createRateLimiter" server/middleware/rateLimiter.mjs | head -3
```

# Implementare — PARTEA A: restrânge policy-ul Report-Only
Elimină `style-src 'self'` din directivele Report-Only (linia ~589) — e responsabilă pentru
aproape tot volumul (confirmat în captură: toate violările din log sunt `style-src-attr`).
Păstrează `script-src`/`script-src-attr` — acelea sunt partea REALĂ de tech debt de urmărit
(eliminarea `unsafe-inline` din `scriptSrc`), nu stilurile inline (risc de securitate mult mai
mic decât scripturile inline, și volumul lor ascunde semnalul util).
```js
res.setHeader('Content-Security-Policy-Report-Only', [
  `script-src 'self' 'nonce-${nonce}' https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com`,
  `script-src-attr 'none'`,
  `report-uri /api/csp-report`,
].join('; '));
```
(Elimină linia `style-src 'self'` complet — nu o înlocui cu `style-src 'unsafe-inline'`, doar
scoate directiva; fără ea, browserul nu raportează deloc pe stiluri.)

# Implementare — PARTEA B: dedup + sampling pe handler-ul de raportare
Chiar restrâns, un volum mare de violări IDENTICE (același `source-file`+`line-number`+
`violated-directive`, de la mai mulți useri) tot poate umple logurile. Adaugă un dedup simplu
în memorie (per-instanță, TTL scurt — nu are nevoie de DB/Redis):
```js
const _cspSeen = new Map(); // key -> lastLoggedAt (ms)
const CSP_DEDUP_WINDOW_MS = 5 * 60_000; // 5 minute
function _cspDedupKey(v) {
  return `${v?.['violated-directive'] || v?.violatedDirective || ''}|${v?.['source-file'] || v?.sourceFile || ''}|${v?.['line-number'] || v?.lineNumber || ''}`;
}
```
În handler, înainte de `logger.info`, verifică/actualizează `_cspSeen`: dacă aceeași cheie a
fost logată în ultimele `CSP_DEDUP_WINDOW_MS`, INCREMENTEAZĂ un contor local (opțional, sau
sari logarea complet) în loc să scrii din nou log complet; altfel loghează normal și
resetează timestamp-ul. Curăță periodic `_cspSeen` (ex. la fiecare 10 min, șterge intrările
mai vechi de `CSP_DEDUP_WINDOW_MS`) ca să nu crească nelimitat.
```js
app.post('/api/csp-report', _cspReportLimiter, _cspReportParser, (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(204).end();
    const ct = req.headers['content-type'] || '';
    const reports = (ct.includes('application/reports+json') && Array.isArray(body))
      ? body
      : [body['csp-report'] ?? body];
    for (const violation of reports) {
      const key = _cspDedupKey(violation);
      const now = Date.now();
      const last = _cspSeen.get(key);
      if (last && (now - last) < CSP_DEDUP_WINDOW_MS) continue; // deja logat recent — skip
      _cspSeen.set(key, now);
      logger.info({ cspViolation: violation }, 'csp-violation');
    }
  } catch (_) { /* corp malformat — ignorat */ }
  res.status(204).end();
});

setInterval(() => {
  const cutoff = Date.now() - CSP_DEDUP_WINDOW_MS;
  for (const [k, ts] of _cspSeen) if (ts < cutoff) _cspSeen.delete(k);
}, 10 * 60_000).unref();
```
(Adaptează la structura EXACTĂ a handler-ului găsit în Etapa 0 — nu presupune, verifică.)

# Verificare manuală (fără test automat — e config de rețea/header)
- Pe staging, după deploy: deschide orice pagină cu DevTools → Network → filtrează `csp-report`.
  Ar trebui să vezi ZERO sau foarte puține request-uri (nu zeci per încărcare).
- Verifică în Railway logs că volumul de `csp-violation` a scăzut drastic.
- Confirmă că politica de ENFORCEMENT (headerul `Content-Security-Policy`, NU `-Report-Only`)
  e neschimbată — pagina funcționează exact ca înainte (butoane, stiluri inline încă permise
  acolo, doar raportarea pe stiluri s-a oprit).

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/index.mjs`, `package.json`.
```bash
git diff --name-only | grep -vE "^server/index\.mjs$|^package\.json$" && echo "⛔ STOP: fișier neașteptat!" || echo "✅ scope curat"
git diff server/index.mjs | grep -n "contentSecurityPolicy" && echo "verifică: policy-ul de ENFORCEMENT neschimbat (doar Report-Only atins)"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.610 → 3.9.611.

# La final
```bash
git add server/index.mjs package.json
git commit -m "fix(perf): restrânge CSP Report-Only la script-src (elimină flood style-src-attr) + dedup logging (v3.9.611)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Policy-ul de enforcement (headerul real) neschimbat — doar Report-Only restrâns.
2. Dedup activ — confirmă manual pe staging că volumul de request-uri `csp-report` per pagină a scăzut.
3. Status CI (`npm test` + `npm run check`); versiune 3.9.611.

---

# PARTEA C — de verificat separat pe Railway (NU necesită cod, doar observație)
Erorile `Login error` / `checkLoginRate error` / `Archive job processor error` /
`/api/me/signing-providers error` sunt TOATE pe cale de conectare la DB — posibil legate de
flood-ul CSP (event loop congestionat), posibil o cauză separată. Verifică pe Railway, ÎNAINTE
sau DUPĂ acest fix (independent de el):

1. **Conexiuni active pe Postgres**: din Railway → Postgres → Query, rulează:
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   SHOW max_connections;
   ```
   Dacă `count(*)` e aproape de `max_connections`, pool-ul aplicației (max 20) concurează cu
   alte procese (alt serviciu conectat la aceeași DB? replici multiple ale web service-ului?
   fiecare replică rulează propriul pool de 20 + propriul job de arhivare la 30s).

2. **Câte replici (instances) are serviciul web pe Railway?** Dacă sunt ≥2, `archive_jobs`
   e protejat corect (`FOR UPDATE SKIP LOCKED`), dar fiecare replică are propriul pool de 20
   conexiuni — 2 replici = până la 40 conexiuni posibile spre aceeași Postgres, care poate
   avea o limită mai mică pe planul curent.

3. Dacă erorile persistă și după fix-ul CSP, revino cu rezultatul interogărilor de mai sus —
   scriem un prompt separat (crește/scade `pool.max`, sau investigăm o interogare lentă
   specifică) pe baza a ce arată `pg_stat_activity`.
