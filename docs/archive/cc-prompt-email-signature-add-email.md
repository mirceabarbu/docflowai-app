---
target_branch: develop
model_suggested: Sonnet 4.6 (o linie, frontend)
risk: NONE — pur cosmetic, un câmp în textul implicit al semnăturii.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: adaugă emailul utilizatorului logat în semnătura din modalul de email extern

## Context (verificat)
`public/js/df-email-modal.js`, ~liniile 476–490, compune textul implicit al semnăturii din
obiectul `u = JSON.parse(localStorage.getItem('docflow_user') || '{}')`. `u.email` e DEJA
disponibil (folosit ca fallback la `senderName`, ~:476). Câmpurile existente:
```
const functieStr     = u.functie ? `\nFuncție: ${u.functie}` : '';
const institutieStr  = (u.institutie || institutie) ? `\nInstituție: ${u.institutie || institutie}` : '';
...
Nume: ${senderName}${functieStr}${institutieStr}${compartimentStr}
```

## Cerință (owner)
În semnătură, afișează adresa de email a utilizatorului logat, PLASATĂ între `Funcție` și `Instituție`.

## Modificare cerută
1. Adaugă, după `functieStr`:
   ```
   const emailStr = u.email ? `\nEmail: ${u.email}` : '';
   ```
   (gardat, în același stil ca celelalte câmpuri).
2. Inserează `${emailStr}` ÎNTRE `${functieStr}` și `${institutieStr}` în template:
   ```
   Nume: ${senderName}${functieStr}${emailStr}${institutieStr}${compartimentStr}
   ```

## Zone interzise
- NIMIC altceva — nu schimba subiectul, corpul, destinatarii, logica de trimitere, backend-ul.
- NU atinge NO-TOUCH / `migrate.mjs`.

## Definition of done
- Semnătura arată `Email: <adresă>` între `Funcție` și `Instituție` (sau nimic dacă `u.email` lipsește).
- `npm test verde` + `npm run check` verde.
- Cache busting `?v=` pe `df-email-modal.js` în HTML-ul care îl încarcă + bump `package.json`
  patch +1 (citește versiunea curentă) + CACHE_VERSION dacă există convenția.
- Commit + push DOAR pe `develop`. STOP înainte de `main`.
