# FIX: Audit formular — compartiment ORD, diacritice titlu, închidere modal

> ⚠️ **BRANCH: `develop` EXCLUSIV.** NU face checkout/merge/push pe `main`.
> `main` = producție, gestionat manual de Mircea. Toată munca rămâne pe `develop`.
>
> ⚠️ **NO-TOUCH:** fluxul STS/PAdES. Acest fix atinge DOAR endpoint-ul de audit
> formular (`/api/formulare-audit/...` din `server/routes/formulare-db.mjs`) și
> UI-ul de audit din `public/js/formular/`. **NU modifica `server/routes/admin/flows.mjs`.**

---

## Bug 1 — Compartiment gol la ORD (și uniformizare DF)

În header-ul exportului de audit, „Compartiment" e citit din coloana
`compartiment_specialitate` a tabelei `formulare_ord`, care e de regulă goală.

**Fix:** sursa canonică de compartiment este compartimentul **inițiatorului** din
`users` (vezi lista: `u1.compartiment AS initiator_comp`, liniile 1681 DF / 1778
ORD din `formulare-db.mjs`). În query-ul care încarcă datele de header pentru
audit, fă `LEFT JOIN users u_init ON u_init.id = <tabela>.created_by` și folosește:

```sql
COALESCE(NULLIF(TRIM(u_init.compartiment), ''), NULLIF(TRIM(<tabela>.compartiment_specialitate), '')) AS compartiment
```

Aplică identic pentru ambele tipuri (df și ord). Inițiatorul afișat
(`Test <test@docflowai.ro>`) provine deja din `users` — păstrează-l.

## Bug 2 — Diacritice trunchiate în titlu/PDF („Ordonanare de Plat")

Funcția `ro()` din generarea PDF aplică `replace(/[^\x00-\xFF]/g,'')` ÎNAINTE de
maparea diacriticelor. `ț` (U+021B) și `ă` (U+0103) sunt > 0xFF → sunt eliminate
înainte să fie convertite în `t`/`a`.

**Fix:** inversează ordinea — **mapează diacriticele întâi, apoi fă strip-ul**:

```js
// ÎNAINTE (greșit):
// const ro = t => String(t||'').replace(/[^\x00-\xFF]/g,'').split('').map(ch=>diacr[ch]||ch).join('');

// DUPĂ (corect):
const ro = t => String(t || '').split('').map(ch => diacr[ch] || ch).join('').replace(/[^\x00-\xFF]/g, '');
```

Asigură-te că maparea `diacr` acoperă variantele cu virgulă (`ș` U+0219, `ț` U+021B)
și cu sedilă (`ş` U+015F, `ţ` U+0163), majuscule incluse. După fix:
„Ordonanțare de Plată" → „Ordonantare de Plata".

> Notă: același bug de ordine există latent și în `admin/flows.mjs`, dar acel
> fișier rulează în producție — NU îl atinge în acest task.

## Bug 3 — Modalul de audit nu se închide după export

În `public/js/formular/` (handler-ul `openFormAudit` / butoanele de export din
modalul `#audit-modal`): după ce se declanșează download-ul (PDF **și** CSV),
închide modalul.

**Fix:** în callback-ul de export, după ce ai inițiat download-ul, apelează
funcția de închidere a modalului (aceeași folosită de butonul „×"/„Închide" —
ex. `closeAuditModal()` sau setarea `display:none` pe `#audit-modal`). Aplică
pentru ambele butoane (PDF și CSV).

## Verificare

- `npm test` → **verde, fără regresii.**
- `npm run check` → fără erori de sintaxă.
- Manual:
  - export audit pe un ORD → „Compartiment" afișează compartimentul inițiatorului
    (ex. „Serviciul Buget"), nu gol;
  - titlul în PDF afișează „Ordonantare de Plata" complet (fără litere lipsă);
  - după click pe „Export PDF" sau „Export CSV", modalul se închide.

## Cache-busting

- Bumpează `version` în `package.json` la următoarea valoare patch (verifică
  valoarea curentă).
- Bumpează `?v=` doar pe referințele către fișierele atinse din `public/formular.html`.

## Finalizare (obligatoriu)

```bash
git add .
git commit -m "fix(audit-formular): compartiment ORD din initiator, ordine diacritice ro() in PDF, inchide modal dupa export"
git push origin develop
```
