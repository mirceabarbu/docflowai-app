---
prompt: 196
titlu: "RECON: cele 18 copii ale predicatului de flux — care se consolidează și care NU"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.849
tip: RECON — READ-ONLY
livrabil: TABEL DE CLASIFICARE + plan. Zero cod livrat, zero commit, zero push.
---

# ⚠️ CE ESTE ȘI CE NU ESTE LOTUL ĂSTA

Ăsta e un **recon**. Livrabilul e o **clasificare**, nu un patch.

- ⛔ **NU consolida nimic.** Nici măcar ocurențele „evident identice".
- ⛔ **NU face commit. NU face push.**
- ⛔ **NU modifica niciun fișier trackat.** Confirmă la final cu `git status --short`.

Motivul e concret: două dintre cele 18 ocurențe nu sunt predicate de proveniență, ci filtre
de afișare. Consolidate din reflex, ar schimba tăcut ce vede utilizatorul în listele lui,
fără ca vreun test să pice. Întâi stabilim care e care.

---

## Contextul

`server/services/flow-provenance.mjs` deține sursa unică, cu două fragmente **distincte**:

- **`validSignedFlowSql(alias)`** — flux „valid semnat": nețters, ne-anulat, ne-refuzat
  **ȘI** marcat finalizat.
- **`liveFlowSql(alias)`** — flux „viu": nețters, ne-anulat, ne-refuzat. Un flux `completed`
  **E** viu aici.

⚠️ Docblock-ul lui `liveFlowSql` conține o decizie care trebuie respectată, nu redescoperită:
excluderea lui `refused` **nu** e în specul original, dar e **necesară** pentru clasa D — fără
ea, o reinițiere legitimă după refuz (flux vechi refuzat + flux nou activ, același
`meta.dfId`) ar apărea permanent ca „fluxuri paralele", iar cardul n-ar ajunge niciodată la 0.

În afara acestui fișier există **18** ocurențe scrise de mână ale tiparului
`data->>'status' IS DISTINCT FROM 'cancelled'`:

| Fișier | Ocurențe |
|---|---|
| `server/services/df-aprobat-sql.mjs` | 2 |
| `server/services/alop-dosar-sql.mjs` | 1 |
| `server/routes/flows/crud.mjs` | 4 |
| `server/routes/formulare/shared.mjs` | 4 |
| `server/routes/formulare/df.mjs` | 2 |
| `server/routes/notifications.mjs` | 2 |
| `server/routes/formulare/ord.mjs` | 1 |
| `server/routes/admin/flows.mjs` | 1 |
| `server/routes/alop.mjs` | 1 |

⭐ **Cel puțin două NU sunt consolidabile.** `crud.mjs:910` și `:916` sunt filtrele de status
ale listei de fluxuri (`pending`, `to_sign`). `to_sign` exclude `cancelled` și `completed`,
dar **nu** `refused` — aparent deliberat. Sunt predicate de **prezentare**, nu de proveniență.
Ia-le ca dovadă că tiparul textual nu implică aceeași semnificație, și caută activ altele la fel.

---

## ETAPA A — inventarul complet

Pentru **fiecare** dintre cele 18, produ un rând cu:

1. `fișier:linie`
2. **La ce servește** — o propoziție: ce întrebare pune interogarea (proveniență? vizibilitate
   în listă? condiție de notificare? gardă la lansare?).
3. **Textul exact** al predicatului, așa cum e scris.
4. **Se potrivește caracter cu caracter** cu `validSignedFlowSql`, cu `liveFlowSql`, sau cu
   niciunul? Dacă cu niciunul, **care e diferența exactă** (termen în plus, termen lipsă,
   altă ordine).
5. **Clasificare**, una dintre:
   - `CONSOLIDABIL` — echivalent semantic cu unul dintre fragmente; înlocuirea nu schimbă
     nicio mulțime de rezultate.
   - `PREZENTARE` — filtru vizibil utilizatorului. Nu se atinge.
   - `DIVERGENT-INTENȚIONAT` — diferă, iar diferența pare voită. Spune de ce crezi asta.
   - `DIVERGENT-SUSPECT` — diferă, iar diferența pare scăpată. ⭐ Ăsta e cel mai valoros
     rezultat al reconului: o divergență nevoită e un bug care există **acum**.
6. **Ce s-ar schimba dacă ar fi înlocuit** — concret: ce rânduri ar intra sau ar ieși din
   rezultat. Dacă nimic, spune „mulțime identică" și argumentează.

---

## ETAPA B — întrebările care decid forma lotului următor

1. **De ce `df-aprobat-sql.mjs` și `alop-dosar-sql.mjs` au copii proprii?** Sunt tot în
   `server/services/`. E risc de import circular cu `flow-provenance.mjs`, sau doar istorie?
   Verifică graful de importuri, nu presupune.
2. **Există ocurențe care folosesc un alias pe care fragmentele nu-l pot produce** — subinterogări
   fără alias, `data->>` pe expresie, alias generat dinamic?
3. **Câte dintre cele `CONSOLIDABIL` sunt acoperite azi de un test** care ar pica dacă
   predicatul s-ar schimba greșit? Dacă răspunsul e „puține", consolidarea trebuie precedată
   de teste, nu urmată.
4. Mai există în `server/` alt tipar-frate necontorizat — de exemplu
   `(data->>'completed')::boolean = true` scris singur, fără partea de `cancelled`?

---

## ETAPA C — raportul

1. **Tabelul din Etapa A**, complet, toate cele 18.
2. **Numărătoarea pe clase**: câte `CONSOLIDABIL`, câte `PREZENTARE`, câte `DIVERGENT-*`.
3. ⭐ **Lista `DIVERGENT-SUSPECT`**, cu efectul concret al fiecăreia. Dacă vreuna e un bug
   viu, spune-o răspicat și estimează ce se vede în aplicație din cauza ei.
4. Răspunsurile la cele patru întrebări din Etapa B.
5. **Planul propus** pentru lotul de consolidare: ce se atinge, ce nu, în ce ordine, ce teste
   trebuie scrise **înainte**. Descris, **NU implementat**.
6. **Recomandarea ta**, inclusiv varianta „nu merită". ⚠️ Dacă ies 3 consolidabile din 18,
   lotul nu merită riscul — e un rezultat legitim și vreau să-l spui, nu să-l ocolești.
7. `git status --short` — confirmarea că nu ai lăsat nimic în urmă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. **Zero commit, zero push, zero fișiere trackate modificate.**
- ⛔ Nu consolida. Nu „pregăti terenul". Nu adăuga teste.
- ⛔ Nu modifica `flow-provenance.mjs` — nici măcar comentariile.
- ⛔ Excluderea lui `refused` din `liveFlowSql` e o **decizie luată** (clasa D). Nu o
  repune în discuție; dacă crezi că e greșită, scrie asta la constatări, nu în cod.
- Dacă o ocurență nu se încadrează curat în niciuna dintre cele patru clase, spune asta.
  O clasificare forțată e mai rea decât una incompletă.
