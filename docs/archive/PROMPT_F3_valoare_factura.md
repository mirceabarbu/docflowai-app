---
title: "Facturi — F3 (valoare factură: modal lichidare + coloană + total centralizator + notificare)"
branch: develop
model_suggested: Opus 4.8   # schemă + modal financiar + centralizator + arhivare cicluri
version_bump: citește versiunea curentă din package.json și incrementează patch (aștept 3.9.693 → 3.9.694)
cache_bump: NU (niciun fișier din PRECACHE_ASSETS atins)
depends_on: F1 + F2 (deja pe develop)
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, MANUAL de Mircea. NU checkout/merge/push pe `main`.

====================================================================
OBIECTIV
====================================================================
Capturăm VALOAREA facturii la lichidare (azi capturăm doar nr/dată). Se propagă în:
  • modalul de lichidare (input nou),
  • endpoint `confirma-lichidare` (body + coloană),
  • arhivarea ciclului (`noua-lichidare`),
  • centralizatorul `GET /api/alop/facturi` (coloană nouă) + tabelul read-only (coloană + TOTAL),
  • mesajul notificării CAB (adaugă „valoare X RON").

⛔ NO-TOUCH: server/signing/*. Citește fiecare fișier ÎNAINTE de a-l modifica (F1/F2 au
schimbat deja alop.mjs și facturi.js — nu te baza pe amintiri, deschide fișierele).

====================================================================
PAS 1 — Migrație inline (2 coloane, ADD-ONLY idempotent)
====================================================================
```bash
grep -oE "id: '[0-9]{3}_[a-z0-9_]+'" server/db/index.mjs | sort | tail -3
# Așteptat: ultimul e 098_module_facturi (de la F1) → folosește 099
```
Adaugă după ultima migrație:
```js
  {
    id: '099_lichidare_valoare_factura',
    sql: `
      ALTER TABLE alop_instances   ADD COLUMN IF NOT EXISTS lichidare_valoare_factura NUMERIC(18,2);
      ALTER TABLE alop_ord_cicluri ADD COLUMN IF NOT EXISTS lichidare_valoare_factura NUMERIC(18,2);
    `
  },
```

====================================================================
PAS 2 — Modal lichidare (public/formular.html): input „Valoare factură (RON)"
====================================================================
Citește blocul `id="modal-lichidare"` (≈ liniile 1215-1265). Există un rând cu Nr. factură
+ Data factură, apoi rândul Nr. PV + Data PV, apoi Observații. Adaugă un input de valoare.
Recomandat: pe rândul facturii, ca a treia coloană, SAU rând propriu între factură și PV.

Găsește ancora (începutul rândului PV) și inserează ÎNAINTE de el:
```html
      <div>
        <label class="alop-lbl">Valoare factură (RON)</label>
        <input id="lich-valoare-factura" type="text" inputmode="decimal" autocomplete="off"
          placeholder="Ex: 1234,56"/>
      </div>
```
(Dacă rândul facturii e un grid 1fr 1fr, poți face un rând nou 100% pentru valoare — nu
strica grid-ul existent. Alege plasarea care arată curat; descrie în RAPORT unde ai pus-o.)

====================================================================
PAS 3 — confirmLichidare (public/js/formular/alop.js)
====================================================================
3.1 Citește `confirmLichidare()` (≈ linia 977) și adaugă în `body` câmpul valoare, cu
parsare RO robustă (acceptă „1.234,56" și „1234.56"):
old_str:
```js
    observatii:   (document.getElementById('lich-observatii')?.value||'').trim(),
  };
```
new_str:
```js
    observatii:   (document.getElementById('lich-observatii')?.value||'').trim(),
    valoare_factura: _parseValoareFactura(document.getElementById('lich-valoare-factura')?.value),
  };
```
3.2 Adaugă helperul de parsare (o singură dată, în același fișier, în afara funcției):
```js
function _parseValoareFactura(raw){
  const s = (raw||'').toString().trim();
  if(!s) return null;
  let t = s.replace(/\s/g,'');
  if(t.includes(',') && t.includes('.')) t = t.replace(/\./g,'').replace(',','.'); // RO: 1.234,56
  else t = t.replace(',', '.');                                                    // 1234,56 / 1234.56
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
```
3.3 În `openAlopConfirmLichidare` (blocul care golește câmpurile la deschidere, ≈ linia 965),
adaugă `'lich-valoare-factura'` în lista de id-uri resetate. Citește lista existentă și
adaugă id-ul (nu rescrie tot dacă nu e nevoie).

====================================================================
PAS 4 — Endpoint confirma-lichidare (server/routes/alop.mjs)
====================================================================
Citește handlerul. Adaugă `valoare_factura` la destructurarea body-ului și scrie coloana.
4.1 Destructurare:
old_str:
```js
    const { notes, observatii, nr_factura, data_factura, nr_pv, data_pv } = req.body;
```
new_str:
```js
    const { notes, observatii, nr_factura, data_factura, nr_pv, data_pv, valoare_factura } = req.body;
```
4.2 UPDATE — adaugă coloana ca param NOU la finalul array-ului (păstrează $7=id, $8=org):
old_str:
```js
          lichidare_data_pv=$6,
          status='ordonantare',
```
new_str:
```js
          lichidare_data_pv=$6,
          lichidare_valoare_factura=$9,
          status='ordonantare',
```
și extinde array-ul de parametri (adaugă al 9-lea element la final):
old_str:
```js
    `, [actor.userId, observatii || notes || '', nr_factura || null, data_factura || null, nr_pv || null, data_pv || null, req.params.id, actor.orgId]);
```
new_str:
```js
    `, [actor.userId, observatii || notes || '', nr_factura || null, data_factura || null, nr_pv || null, data_pv || null, req.params.id, actor.orgId, (valoare_factura != null && Number.isFinite(Number(valoare_factura))) ? Number(valoare_factura) : null]);
```

4.3 Notificarea CAB (blocul adăugat de F1) — include valoarea în mesaj. Citește blocul și
extinde mesajul. Ex.:
old_str (aproximativ — adaptează la textul real din F1):
```js
          const dataFactTxt = data_factura
            ? ' din ' + new Date(data_factura).toLocaleDateString('ro-RO')
            : '';
```
new_str:
```js
          const dataFactTxt = data_factura
            ? ' din ' + new Date(data_factura).toLocaleDateString('ro-RO')
            : '';
          const valFact = (valoare_factura != null && Number.isFinite(Number(valoare_factura))) ? Number(valoare_factura) : null;
          const valTxt = valFact != null
            ? ', valoare ' + new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(valFact) + ' RON'
            : '';
```
și în mesajul notificării adaugă `${valTxt}` după `${dataFactTxt}`. De asemenea, pune
`valoare_factura: valFact` în obiectul `notifData`.

====================================================================
PAS 5 — noua-lichidare: arhivează + resetează valoarea
====================================================================
Citește handlerul `POST /api/alop/:id/noua-lichidare` (≈ 1389). Găsește INSERT-ul în
`alop_ord_cicluri` și UPDATE-ul de reset.
5.1 INSERT: adaugă coloana `lichidare_valoare_factura` în lista de coloane și
`alop.lichidare_valoare_factura` în lista de valori (poziții corespondente!). Verifică
numărul de coloane vs. numărul de `$n` după inserare.
5.2 Reset UPDATE: adaugă `lichidare_valoare_factura = NULL,` lângă celelalte reset-uri
`lichidare_* = NULL`.

====================================================================
PAS 6 — Centralizator GET /api/alop/facturi (coloană nouă)
====================================================================
Citește ruta (adăugată de F1). Adaugă în AMBELE jumătăți ale UNION-ului coloana valoare,
pe aceeași poziție (ordinea coloanelor în UNION trebuie să corespundă):
  • jumătatea „curent": `a.lichidare_valoare_factura AS valoare,`
  • jumătatea „ciclu":  `c.lichidare_valoare_factura AS valoare,`
Adaug-o consistent (ex. imediat după `nr_factura`/`data_factura` sau înainte de `sursa` —
important e să fie pe ACEEAȘI poziție în ambele SELECT-uri).

====================================================================
PAS 7 — Tabelul facturi (public/js/formular/facturi.js + #facturi-section)
====================================================================
Citește `public/js/formular/facturi.js` și secțiunea `#facturi-section` din formular.html.
7.1 Adaugă un `<th>Valoare</th>` în header (recomandat după „Data factură"), aliniat la
    dreapta, și celula corespunzătoare în `renderRow`.
7.2 Formatare RON — adaugă un helper local (nu există helper global):
```js
function fmtRON(v){
  if(v==null||v==='') return '';
  const n = parseFloat(v);
  if(!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' RON';
}
```
Celula: `<td style="text-align:right;font-variant-numeric:tabular-nums;">${fmtRON(f.valoare)||'<span class="fact-muted">—</span>'}</td>`
7.3 TOTAL: după ce populezi `tbody`, calculează suma valorilor și afișeaz-o. Adaugă un
`<tfoot>` în tabel (sau un rând total în tbody) cu „TOTAL: X RON" pe coloana Valoare.
Total = suma `f.valoare` pe rândurile AFIȘATE (relevant mai ales după F4 cu filtre — dar
F4 vine separat; aici totalul e pe toate rândurile). Actualizează și contorul dacă vrei.

====================================================================
PAS 8 — Version bump + teste
====================================================================
```bash
node -p "require('./package.json').version"           # citește versiunea curentă
# incrementează patch (ex. 3.9.693 → 3.9.694) în package.json
node -p "require('./package.json').version"           # confirmă noua valoare
# ?v= bulk pe HTML (facturi.js/alop.js/formular.html s-au schimbat)
# (rulează același sed ca la F2, cu noua versiune)
npm test                                              # Așteptat: verde, fără regresii
```
NU bumpa CACHE_VERSION (niciun fișier din PRECACHE_ASSETS atins).

====================================================================
VERIFICARE MANUALĂ
====================================================================
1. Deschide un ALOP în faza Lichidare → modalul are câmpul „Valoare factură (RON)".
   Introdu „1.234,56" → confirmă → în centralizator apare „1.234,56 RON" pe rând.
2. Centralizatorul are coloana Valoare aliniată dreapta + rând TOTAL corect.
3. Un user din Serviciul Buget primește notificarea cu „…valoare 1.234,56 RON".
4. Fă `noua-lichidare` pe un ALOP finalizat → ciclul arhivat păstrează valoarea; noul ciclu
   pornește cu valoare goală.

====================================================================
RAPORT FINAL (id migrație, unde ai pus inputul, confirmarea poziției coloanei în UNION,
numărul de $n în noua-lichidare, npm test, versiune, presupuneri verificate)
====================================================================
⛔ develop ONLY · NU signing/* · migrații INLINE · citește fișierele înainte de patch ·
   verifică aritmetica parametrilor SQL (un $n greșit = bug financiar tăcut).
