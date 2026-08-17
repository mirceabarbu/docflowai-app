---
prompt: ALOP-CAB
titlu: "feat(authz): compartimentul CAB al organizației vede și editează tot ALOP/DF/ORD"
model_suggested: Opus 4.8
branch: develop
zona: server/services/authz-formular.mjs, server/routes/formulare/{shared,df,ord}.mjs, server/routes/alop.mjs, teste
versiune_tinta: v3.9.690
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.689)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.
>
> ⚠️ Acesta e un **fix funcțional de producție**, cerut de owner. Merge repede în `main` după validare —
> deci grija la izolarea pe org e maximă: o gaură aici înseamnă că Serviciul Buget al unei primării
> vede documentele ALTEI primării.

---

## CONTEXT — cerința owner-ului

În fiecare organizație există un **compartiment CAB implicit** (`organizations.cab_compartiment` —
la primăria curentă: „Serviciul Buget"). Setat în admin → Organizații → Compartiment CAB implicit.

Azi acest compartiment **NU are vizibilitate specială**. Un utilizator din Serviciul Buget vede un
ALOP/DF/ORD doar dacă e inițiator, semnatar, sau din compartimentul inițiatorului — exact ca oricine.

**Decizia owner-ului (Mircea, 14.07.2026):** utilizatorii din compartimentul CAB al organizației
trebuie să **vadă ȘI să editeze TOT** ALOP/DF/ORD din organizația lor — ca un `org_admin`, dar
limitat la aceste trei module (nu la administrare, useri, setări). E rolul de supraveghere financiară.

⚠️ **Limitat la propria organizație.** „Tot" înseamnă tot din `org_id`-ul actorului. NICIODATĂ din alt org.

---

## Ce ai deja (nu reinventa)

`server/services/authz-formular.mjs` e **centralizat** — DF/ORD/ALOP trec toate prin el:
- `canEditFormular(pool, actor, doc, actorComp, opts)` → DF/ORD editare
- `canViewFormular(pool, actor, doc, actorComp)` → DF/ORD vizualizare (= edit ∪ flow_viewer)
- `canEditAlop(pool, actor, alop, actorComp)` → ALOP editare

Modelul rolului nou există deja: `p2_comp` (membru al compartimentului CAB **al documentului**).
Rolul tău nou, `cab_dept`, e fratele lui — dar se leagă de compartimentul CAB **al organizației**
(`cab_compartiment`), global pe tot, nu de CAB-ul unui document anume.

`cab_compartiment` se citește azi la `shared.mjs:323`. NU inventa alt loc.

---

## PAS 0 — RECON (read-only). Răspunde ÎNAINTE de cod.

```bash
sed -n '/export async function canEditFormular/,/^}/p'  server/services/authz-formular.mjs
sed -n '/export async function canViewFormular/,/^}/p'  server/services/authz-formular.mjs
sed -n '/export async function canEditAlop/,/^}/p'      server/services/authz-formular.mjs
sed -n '318,330p' server/routes/formulare/shared.mjs         # cum se citește cab_compartiment azi
sed -n '392,470p' server/routes/formulare/shared.mjs         # WHERE-ul listării DF/ORD
sed -n '/async function buildAlopVisibilityWhere/,/^}/p' server/routes/alop.mjs
grep -n "loadActorComp\|canEditFormular\|canViewFormular\|canEditAlop" server/routes/formulare/df.mjs server/routes/formulare/ord.mjs server/routes/alop.mjs
```

**Răspunde în raport:**
1. Câte call-site-uri au `canEditFormular` / `canViewFormular` / `canEditAlop`? Fiecare are deja `actorComp`
   din `loadActorComp`. Vor primi și `cabComp` — de unde îl iei în fiecare handler?
2. Listarea DF/ORD (`shared.mjs`) și listarea ALOP (`alop.mjs`) au fiecare un WHERE de vizibilitate.
   Unde exact adaugi ramura „actor în cab_compartiment ⇒ vede tot org-ul"?
3. `cab_compartiment` poate fi NULL/gol (org fără CAB setat). Ce se întâmplă atunci? (Răspuns corect:
   ramura `cab_dept` NU se activează — nimeni nu primește acces extra. Fail-safe, nu fail-open.)

---

## PAS 1 — Helper: e actorul în compartimentul CAB al org-ului?

În `authz-formular.mjs`. Citește `cab_compartiment` o dată și compară cu compartimentul actorului.

```js
// FEAT ALOP-CAB: compartimentul CAB al ORGANIZAȚIEI (organizations.cab_compartiment) e organul
// de supraveghere financiară — vede și editează tot ALOP/DF/ORD din org, ca un org_admin limitat.
// Se leagă de CAB-ul organizației, spre deosebire de `p2_comp` care e CAB-ul unui document anume.
export async function loadOrgCabComp(pool, orgId) {
  if (!orgId) return '';
  const { rows } = await pool.query(
    'SELECT cab_compartiment FROM organizations WHERE id=$1', [orgId]
  );
  return (rows[0]?.cab_compartiment || '').trim();
}

// Pur, testabil. actorComp și cabComp sunt AMBELE deja trimmed.
export function isCabDept(actorComp, cabComp) {
  return !!cabComp && !!actorComp && actorComp === cabComp;
}
```

⚠️ **De ce `loadOrgCabComp` separat, nu un SELECT în fiecare funcție de authz:** listele apelează
`canEditFormular` de zeci de ori per pagină. Un SELECT pe `organizations` în fiecare = zeci de
query-uri redundante. Îl încarci **o dată** în handler și-l pasezi prin `opts`/parametru.

---

## PAS 2 — Rolul `cab_dept` în cele trei funcții de authz

Adaugă `cabComp` ca parametru (sau în `opts`) și verifică-l **după** rolurile existente, înainte de refuz.

**`canEditFormular`** — înainte de `return { allowed: false }`:
```js
  if (opts.cabComp && isCabDept(actorComp, opts.cabComp))
    return { allowed: true, role: 'cab_dept' };
```

**`canEditAlop`** — la fel, înainte de refuz. `canEditAlop` primește `cabComp` ca al 5-lea parametru
(sau prin `opts` — fii consistent cu semnătura existentă).

**`canViewFormular`** — moștenește automat, fiindcă începe cu `canEditFormular`. Confirmă că-i pasează
`opts.cabComp` mai departe.

⚠️ **Semnătura contează.** `canEditFormular(pool, actor, doc, actorComp, opts)` are deja `opts` — pune
`cabComp` acolo, cel mai puțin invaziv. `canEditAlop(pool, actor, alop, actorComp)` NU are `opts` — fie
adaugi un al 5-lea parametru, fie îi adaugi `opts`. Alege una și fii consistent. Raportează ce ai ales.

⚠️ `assignedCounts` din `opts` trebuie păstrat — nu-l pierde când adaugi `cabComp`.

---

## PAS 3 — Cablarea în handlere (editare/vizualizare individuală)

Fiecare call-site din `df.mjs`, `ord.mjs`, `alop.mjs` care cheamă `canEdit*/canView*`:
1. încarcă `cabComp` o dată: `const cabComp = await loadOrgCabComp(pool, actor.orgId);`
2. pasează-l: `canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true, cabComp })`

⚠️ `actor.orgId` — NU orgId-ul documentului. Un membru CAB din org A nu capătă drepturi pe un doc din
org B chiar dacă i-ai da cumva cabComp-ul lui B. Documentul e deja încărcat scopat pe org în rutele
astea (verifică — DF/ORD se încarcă cu `AND org_id=$` în majoritatea handlerelor). Dacă un handler
încarcă documentul FĂRĂ filtru de org, **raportează** — e o gaură preexistentă, o notăm separat.

⚠️ **NU pasa `cabComp` dacă documentul e din alt org.** Cel mai sigur: încarcă `cabComp` din
`actor.orgId`, iar authz-ul verifică apartenența actorului la CAB — deci un doc din alt org n-ar
ajunge oricum aici (e blocat de scoparea pe org la încărcare). Dar dacă vezi un handler care încarcă
doc fără org-scope, oprește-te.

---

## PAS 4 — Vizibilitatea în LISTE (partea care rezolvă plângerea)

### DF/ORD — `shared.mjs`, în WHERE-ul listării

Actorul din `cab_compartiment` vede TOT org-ul. Adaugă o ramură care, când actorul e în CAB, NU mai
restrânge pe compartiment/inițiator — dar PĂSTREAZĂ `fd.org_id=$actorOrg`:

```js
// FEAT ALOP-CAB: membrul CAB al org-ului vede toate documentele org-ului (ca org_admin, doar DF/ORD).
const cabComp = (await loadOrgCabComp(pool, actor.orgId));
const actorInCab = isCabDept(actorComp, cabComp);
if (isOrgAdmin || isAdmin || actorInCab) {
  // vede tot org-ul — DOAR scoparea pe org, fără filtru de compartiment/inițiator
  conds.push(`fd.org_id=$${params.push(actor.orgId)}`);
} else {
  // ... logica existentă pe compartiment/inițiator/assigned, neschimbată
}
```

⚠️ **`isAdmin` (super-admin) NU trebuie amestecat aici fără grijă** — la auditul din 14.07 s-a găsit
că `if(!isAdmin)` sare peste `org_id` la listarea DF/ORD, ceea ce e o inconsistență cunoscută
(super-adminul vede toate org-urile pe DF/ORD, dar doar org-ul propriu pe ALOP). **NU rezolva acea
inconsistență aici** — e alt subiect (#105 din plan). Doar adaugă `actorInCab` la ramura care există,
fără să schimbi comportamentul lui `isAdmin`. Dacă structura actuală face greu asta, raportează cum
arată și mă consult cu owner-ul.

### ALOP — `alop.mjs`, `buildAlopVisibilityWhere`

Funcția returnează deja `''` (fără restricție) pentru `admin`/`org_admin`. Adaugă `cab_dept`:

```js
async function buildAlopVisibilityWhere(actor, params) {
  if (actor.role === 'admin' || actor.role === 'org_admin') return '';
  const actorCompRes = await pool.query('SELECT compartiment FROM users WHERE id=$1', [actor.userId]);
  const actorComp = (actorCompRes.rows[0]?.compartiment || '').trim();
  // FEAT ALOP-CAB: membrul CAB al org-ului vede tot ALOP-ul org-ului.
  const cabComp = (await loadOrgCabComp(pool, actor.orgId));
  if (isCabDept(actorComp, cabComp)) return '';   // fără restricție de vizibilitate în interiorul org-ului
  // ... restul existent
}
```

⚠️ **`return ''` e sigur DOAR pentru că apelantul are deja `a.org_id=$actorOrg` în WHERE-ul principal**
(`alop.mjs:290`). Confirmă asta — dacă listarea ALOP nu are org-scope în afara acestei funcții, un
`return ''` ar scurge alte org-uri. VERIFICĂ înainte, raportează ce ai găsit.

---

## PAS 5 — Teste (⛔ IMPORTĂ din producție; rute reale + Postgres real)

**Unit** — `server/tests/unit/cab-dept-authz.test.mjs`, importând `isCabDept`:
1. `isCabDept('Serviciul Buget', 'Serviciul Buget')` ⇒ true
2. `isCabDept('Contabilitate', 'Serviciul Buget')` ⇒ false
3. `isCabDept('', 'Serviciul Buget')` ⇒ false (actor fără compartiment)
4. `isCabDept('Serviciul Buget', '')` ⇒ false (org fără CAB setat) ← *fail-safe*
5. `isCabDept('serviciul buget', 'Serviciul Buget')` ⇒ false (case-sensitive azi — documentează-l; NU-l repara aici, e legat de datoria `compartiment` din audit)

**DB** — `server/tests/db/cab-dept-visibility.test.mjs`, două organizații, Postgres real.
⚠️ Nume org + emailuri distincte (`organizations.name` UNIQUE). Setează `cab_compartiment='Serviciul Buget'`
pe Org A prin `UPDATE organizations`.

Seed: Org A cu cab='Serviciul Buget'; user-cab-A (compartiment='Serviciul Buget'); user-alt-A
(compartiment='Achizitii'); un DF, un ORD, un ALOP create de user-alt-A (compartiment diferit de CAB).

6. user-cab-A listează DF ⇒ **vede** DF-ul lui user-alt-A (deși nu e din compartimentul lui) ← *cerința*
7. user-cab-A listează ALOP ⇒ **vede** ALOP-ul lui user-alt-A
8. user-cab-A `PUT` pe DF-ul lui user-alt-A ⇒ **200** (poate edita)
9. user-cab-A `canEditAlop` pe ALOP-ul lui user-alt-A ⇒ allowed
10. **IZOLARE:** user-cab-**A** listează/deschide un DF din Org **B** ⇒ **NU-l vede / 403-404** ← *testul critic*
11. **CONTROL NEGATIV:** user-alt-A (NU în CAB) listează ⇒ vede DOAR ce vedea înainte (nu tot org-ul) —
    dovada că n-am dat acces la toată lumea din greșeală
12. Org fără `cab_compartiment` setat ⇒ nimeni nu capătă acces „cab_dept" (fail-safe)

Testul **10** e cel mai important: dovedește că „vede tot" înseamnă „tot org-ul MEU", nu tot sistemul.
Testul **11** dovedește că n-am relaxat vizibilitatea pentru cei care nu-s în CAB.

---

## PAS 6 — Versiune

`package.json` → **v3.9.690**. Verifică dacă atingi `public/` (probabil NU — e authz de server).
Dacă frontend-ul are nevoie să AFIȘEZE ceva diferit pentru cab_dept (ex. badge „vizualizare CAB"),
**raportează** — dar NU face frontend în acest prompt fără să confirmi cu owner-ul. Fix-ul de acces e server-side.

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
feat(authz): compartimentul CAB al organizației vede și editează tot ALOP/DF/ORD (v3.9.690)
```

---

## RAPORT FINAL

1. Câte call-site-uri primesc acum `cabComp`? Ai încărcat `cab_compartiment` O DATĂ per handler (nu în fiecare authz)?
2. `canEditAlop` — parametru nou sau `opts`? Ce ai ales, consistent peste tot?
3. **Testul 10 (izolare cross-org)** — verde? Lipește. *Fără el, fix-ul e o breșă.*
4. **Testul 11 (control negativ — non-CAB nu vede tot)** — verde? Lipește.
5. Testul 6/7/8 (CAB vede și editează documente din alte compartimente ale org-ului) — verzi?
6. Org fără `cab_compartiment` (testul 12) — nimeni nu capătă acces? Fail-safe confirmat?
7. Ai atins comportamentul lui `isAdmin` la listarea DF/ORD? (**Trebuie să fie NU** — e #105, alt subiect.)
8. Vreun handler încarcă documentul FĂRĂ org-scope, unde `cabComp` ar putea traversa org-uri? Ce ai găsit?
9. `buildAlopVisibilityWhere` cu `return ''` — apelantul are `a.org_id=$` în WHERE-ul principal? Confirmă.
10. `git diff --name-only`. `npm test` + `npm run test:db`, separat, ambele verzi.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **„Tot" = tot din `actor.orgId`.** Niciodată alt org. Testul 10 e obligatoriu.
- ⛔ **Fail-safe pe `cab_compartiment` gol/NULL:** ramura `cab_dept` NU se activează. Niciun acces extra.
- ⛔ **Nu atinge comportamentul `isAdmin`** la listarea DF/ORD — e inconsistența cunoscută din audit, o rezolvăm la #105.
- ⛔ `cab_compartiment` citit O DATĂ per handler, nu în fiecare apel de authz.
- ⛔ `assignedCounts` din `opts` păstrat.
- ⛔ Zona NO-TOUCH `server/signing/*` — neatinsă.
