# DocFlowAI – stabilization tranche (2026-03-09)

## Ce este inclus

Această livrare nu este încă refactorizarea completă v4 pentru toate paginile, dar este o tranșă solidă și deployabilă care:
- corectează blocajele vizibile din **Fluxurile mele** și din descărcarea PDF-ului final;
- mută logica critică de status/PDF în servicii backend reutilizabile;
- introduce primele module frontend reutilizabile pentru zona de inițiator;
- pregătește baza pentru refactorizarea mare pe module.

## Fișiere noi

### Backend
- `server/services/storageService.mjs`
- `server/services/searchService.mjs`
- `server/lib/logger.mjs`

### Frontend
- `public/js/core/api.js`
- `public/js/core/auth.js`
- `public/js/core/dom.js`
- `public/js/core/format.js`
- `public/js/initiator/my-flows.js`

## Fișiere modificate
- `server/routes/flows.mjs`
- `server/routes/admin.mjs`
- `public/semdoc-initiator.html`

## Corecții aplicate

### 1) Descărcare PDF final – doar pentru flux finalizat cu succes
S-a unificat logica de status în `storageService.mjs`:
- nu mai permite download dacă fluxul este `refused`;
- nu mai permite download dacă fluxul este `review_requested`;
- nu mai permite download dacă fluxul este `cancelled`;
- permite download doar când fluxul este finalizat cu succes **și** PDF-ul final există.

Afectează:
- `GET /flows/:flowId/signed-pdf`
- `GET /my-flows/:flowId/download`
- cardurile din `Fluxurile mele`

### 2) Mesajul „Se procesează PDF...”
Acum apare doar dacă:
- fluxul este finalizat cu succes;
- dar PDF-ul final nu este încă disponibil.

Nu mai apare pentru fluxuri refuzate / anulate / trimise spre revizuire.

### 3) Anti-autocomplete mai agresiv în „Fluxurile mele”
S-a introdus un helper dedicat care recreează dinamic inputul de căutare și îl golește la:
- încărcarea paginii;
- revenirea în pagină;
- refocus tab.

Asta reduce mult autofill-ul agresiv din Chrome/Edge.

### 4) Calcul DB size / archive-preview / clean-preview
Rutele admin folosesc acum helper-ele reutilizabile din `storageService.mjs` pentru calculul dimensiunii reale a PDF-urilor din `flows_pdfs`.

## Observație importantă
Pentru a păstra riscul scăzut, această tranșă nu scoate încă tot JS-ul inline din paginile mari.
Baza pentru asta a fost creată prin noile module `public/js/core/*` și `public/js/initiator/my-flows.js`.
