---
target_branch: develop
model_suggested: Sonnet 4.6
risk: ZERO funcțional — report-only NU blochează nimic. Doar colectează date.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: CSP Faza 0 — politică strictă în REPORT-ONLY (colectare violări, fără enforcement)

## De ce faza 0 (citește înainte)
A scoate `unsafe-inline` din `scriptSrcAttr` cere eliminarea TUTUROR handler-elor inline
(`onclick=` etc.): admin.html ~163, formular.html ~99, + altele = ~294, fără bundler. E un
refactor mare, predispus la regresii (un buton de admin care tace). NU se face dintr-o dată.
Faza 0 NU schimbă enforcement-ul — adaugă o politică strictă DOAR în report-only, ca să VEZI
exact ce și unde violează, înainte să atingi vreun handler. Risc funcțional zero.

## Context (verificat)
`server/index.mjs` (~:545) — helmet CSP enforcing:
- `scriptSrc: ['self','unsafe-inline', unpkg, jsdelivr, cdnjs]`
- `styleSrc: ['self','unsafe-inline']`
- `scriptSrcAttr: ['unsafe-inline']`
Există deja infra de nonce (HTML-urile nu se cache-uiesc, ~:684).

## Modificări cerute (toate aditive, non-blocante)
1. **Header `Content-Security-Policy-Report-Only`** suplimentar, pe lângă cel enforcing al lui
   helmet (nu-l înlocui pe cel enforcing). Politica strictă de raportat:
   - `script-src 'self' <nonce>` (FĂRĂ `unsafe-inline`; păstrează CDN-urile DOAR dacă sunt
     efectiv folosite — altfel raportează-le ca țintă de eliminat);
   - `script-src-attr 'none'` (asta va raporta fiecare `onclick=`);
   - `style-src 'self'` (raportează inline styles, doar informativ);
   - `report-uri /api/csp-report` (+ `report-to` dacă vrei, opțional).
2. **Endpoint `POST /api/csp-report`** ușor, care primește rapoartele și le LOGHEAZĂ structurat
   (`logger.info({ cspViolation })`), grupabil pe `document-uri` + `violated-directive`.
   - Rate-limit / cap pe el (oricine poate POST-a). Nu-l lăsa să umple logurile fără limită.
   - Acceptă atât `application/csp-report` cât și `application/reports+json`.
3. NIMIC din politica ENFORCING nu se schimbă. `unsafe-inline` rămâne unde e, acum.

## Zone interzise
- NU elimina `unsafe-inline` din politica enforcing (asta e faza 1+, alt task).
- NU atinge handler-ele inline din HTML în acest task.
- NU atinge NO-TOUCH / `migrate.mjs`.

## Definition of done
- Aplicația trimite ambele headere (enforcing neschimbat + report-only strict).
- `/api/csp-report` loghează violările, rate-limited.
- `npm test verde` + `npm run check` verde. Nicio funcționalitate UI afectată (report-only).
- Bump `package.json` patch +1 (+ CACHE_VERSION dacă atingi vreun HTML pentru nonce).
- Commit + push DOAR pe `develop`. STOP înainte de `main`.
- Raport: politica report-only adăugată, și — după ce stă puțin pe staging — un REZUMAT al
  violărilor pe pagină (câte `script-src-attr` pe admin.html vs formular.html etc.), ca să
  prioritizăm fazele următoare.

## Fazele următoare (NU în acest task — context pentru tine)
- Faza 1: externalizează handler-ele pe pagină, de la mic la mare (flow.html 5 → semdoc-signer
  10 → semdoc-initiator 17 → formular.html 99 → admin.html 163), fiecare commit separat cu
  verificare manuală. Când report-only arată 0 violări pe o pagină, e gata.
- Faza 2: când toate paginile sunt curate, scoate `unsafe-inline` din `scriptSrcAttr`/`scriptSrc`
  din enforcing. Separat: self-hosting al librăriilor CDN ca să scoți unpkg/jsdelivr/cdnjs.
