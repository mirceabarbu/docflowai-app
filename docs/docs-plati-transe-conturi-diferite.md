# Plăți în tranșe sau din conturi diferite

**Introdus:** #209, v3.9.862 (15.09.2026)
**Se folosește rar** — de aceea există documentul ăsta.

---

## Când ai nevoie de asta

Situația care o declanșează: **un ORD e plătit prin mai multe ordine de plată**, iar aplicația nu
poate lega automat toate OP-urile de dosar.

Două cauze tipice:

1. **Furnizor plătit din conturi diferite.** Trezoreria virează o parte pe IBAN-ul din
   ordonanțare și o parte pe alt cont al aceluiași furnizor. Matcher-ul respinge al doilea OP cu
   nota „IBAN diferit față de ordonanțare".
2. **Plată în tranșe.** Primul OP acoperă doar o parte din valoarea ORD-ului. Matcher-ul îl
   marchează „Plată parțială X din Y RON" și așteaptă restul — care poate să nu vină niciodată
   într-o formă recognoscibilă.

**Cum recunoști situația:** dosarul apare plătit cu o sumă mai mică decât ce s-a virat efectiv,
iar în raportul OPME, la filtrul **Probleme**, apar linii `Parțial` sau `Nepotrivit` pe același
furnizor și același angajament.

### Cazul care a generat funcționalitatea

DF 8836 / ORD cu valoarea **20.891,04**, furnizor MORANI CONSTRUCT:

```
OP 2791 — 19.164,51 → Parțial      („Plată parțială 19164.51 din 20891.04 RON")
OP 2792 —  1.726,53 → Nepotrivit   („IBAN diferit față de ordonanțare")
                      ─────────────
                      20.891,04  = exact valoarea ORD-ului
```

Cele două OP-uri stingeau integral ordonanțarea, dar aplicația nu avea cale să le combine.
Utilizatorul a confirmat manual doar al doilea, iar dosarul a apărut plătit cu 1.726,53.

---

## Cine poate face asta

**Doar responsabilul CAB** — membru al compartimentului CAB al organizației. Nu inițiatorul, nu
un coleg de compartiment, nu administratorul de organizație doar pentru că e administrator.

Dreptul e verificat pe server. Dacă butoanele nu apar, nu e o problemă de interfață.

**Fiecare acțiune cere un motiv scris**, minim 10 caractere. Nu e formalitate: e justificarea unei
decizii financiare și rămâne în audit. Scrie ce ai verificat efectiv — „verificat extrasul din
03.09, IBAN secundar al aceluiași furnizor", nu „ok".

---

## Cele trei căi

### A. Ai OP-urile în platformă (din import OPME) — **acceptă linia**

Cazul cel mai frecvent. Importul a adus OP-urile, dar matcher-ul le-a respins.

1. Deschide raportul OPME → filtrul **Probleme**
2. Găsește linia respinsă (`Parțial` sau `Nepotrivit`)
3. **Verifică în extrasul de trezorerie** că plata e reală și aparține dosarului
4. Apasă **Acceptă potrivirea**, alege dosarul ALOP, scrie motivul
5. Aplicația reagreghează automat toate OP-urile legate de dosar

**Ce se întâmplă apoi**, în funcție de sume:

| Rezultat | Înseamnă |
|---|---|
| Dosar închis | Suma OP-urilor egalează valoarea ORD-ului. Plata e confirmată cu **suma totală** și **toate numerele de OP**. |
| Rămâne parțial | Încă lipsește o parte. Linia e acceptată, dosarul așteaptă restul. |
| „Are deja o plată confirmată" | Trebuie întâi **reluată confirmarea** — vezi calea C. |

⭐ Nota originală de respingere **se păstrează** alături de motivul tău. Motivul pentru care
sistemul a respins inițial linia rămâne vizibil.

### B. Nu ai OP-urile în platformă — **confirmare manuală cu listă**

Când plățile nu vin prin import OPME, sau importul nu le-a adus deloc.

În confirmarea manuală a plății, câmpul de OP acceptă **mai multe numere, separate prin virgulă**:
`2791, 2792`. Suma se introduce ca **total**, nu per OP.

Dacă suma diferă de valoarea ORD-ului, aplicația îți arată diferența — **dar nu te oprește**.
Plățile parțiale sunt legitime; dacă un ORD chiar s-a plătit doar parțial, așa trebuie înregistrat.

### C. Dosarul e deja confirmat greșit — **reia confirmarea**

Când o plată a fost confirmată cu o sumă incompletă și trebuie refăcută.

1. Pe ecranul ALOP, lângă plata confirmată: **Reia confirmarea plății**
2. Scrie motivul
3. Confirmarea se desface: dosarul revine în starea **plată**, câmpurile se golesc
4. Apoi urmezi calea A sau B pentru a confirma corect

**Valorile vechi se păstrează integral în audit** (`plata_confirmare_reluata`): numărul de OP,
suma, data, sursa, cine confirmase și când. Dacă ceva merge prost, starea de dinainte se poate
reconstrui.

---

## ⛔ Limite — ce NU se poate, deliberat

**Nu poți relua confirmarea unui ciclu avansat.** Dacă dosarul a trecut deja la ciclul următor
(o nouă lichidare), plata veche a fost absorbită în totalul istoric. Reluarea ar corupe
istoricul, deci aplicația **refuză** cu mesaj explicit.

Dacă ajungi în situația asta, nu forța nimic — semnalează, se tratează separat.

**`suma_totala_platita` nu se atinge niciodată.** E memoria ciclurilor arhivate.

**O linie acceptată manual ocolește verificarea automată de IBAN și de bloc.** Ăsta e chiar
scopul — decizia ta trece peste regula automată. De aceea verificarea în extras, înainte de a
apăsa, nu e opțională: nimic nu te mai oprește după.

---

## Ce era în producție la momentul introducerii

Măsurat pe 15.09.2026:

- **4 linii** „IBAN diferit față de ordonanțare" — 555.075,55 lei, cazurile-țintă
- **8 linii** „date insuficiente pe linia OPME (cif/cod/indicator)"
- **151 linii** „nu există ALOP activ în plată cu acest beneficiar" — **normale**, plăți din afara
  circuitului ALOP (salarii, utilități, transferuri). Nu le atinge.
- **12 linii** `Parțial` pe 4 dosare

⭐ **Contabilitatea agregată era corectă** — zero dosare unde plățile confirmate depășeau totalul
înregistrat. Clasa 8 **nu** subevalua nimic. Problema era de flux, nu de calcul: cifra din dosar
nu reflecta realitatea, dar nicio sumă nu se pierduse în rapoarte.

---

## Note tehnice

**Acceptarea nu conține logică proprie de confirmare.** Marchează linia ca `manual` și recheamă
matcher-ul (`tryAutoConfirmAlop`), care confirmă exact cum o face pe calea automată. Un singur loc
din cod știe să confirme plăți.

**`_processAlop` include în agregare liniile `manual`/`auto` legate de dosar în ciclul curent**,
cele `manual` fără regula de bloc (#209). Înainte agregarea citea doar `pending/unmatched/partial`
și retrecea linia prin `_potrivireBloc`, care ar fi respins-o din nou pe același criteriu.

**Migrația 112** a adăugat tranziția `completed → plata` în matricea de stări ALOP. Fără ea, ruta
de reluare întorcea 500. ⚠️ Tranziția e acum legală **în general**, nu doar prin ruta de reluare —
gărzile stau pe rută (rol CAB, motiv, ciclu neavansat), nu pe poartă.

**Rute:**
- `POST /api/opme/lines/:id/accept` — `{ alopId, motiv }`
- `POST /api/alop/:id/plata/reia` — `{ motiv }`

**Evenimente de audit:** `opme_line_accepted_manual`, `plata_confirmare_reluata`.

**Teste:** `server/tests/db/opme-accept-linie.test.mjs`,
`server/tests/db/plata-reia-confirmare.test.mjs`. Testul 13 reproduce cap-coadă cazul 8836.

---

## Rămas de făcut

**Cele 4 linii „IBAN diferit" existente nu au fost corectate.** Funcționalitatea există; aplicarea
pe dosarele deja afectate e o operațiune manuală, de făcut dosar cu dosar, cu verificarea
extrasului pentru fiecare. Începe cu 8836, care e documentat complet mai sus.
