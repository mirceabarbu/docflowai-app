# PROMPT — HOTFIX vizual (header /setari + secțiune admin)

## CONTEXT

Două bug-uri vizuale după BLOC 4.2 fix:

1. **`/setari` header diferit** de celelalte pagini — am folosit clase CSS care NU EXISTĂ:
   - `<main class="df-main">` → trebuie `<div class="df-page">` + `</div>` la final (cu `<main>` interior păstrat sau eliminat — vezi mai jos)
   - `<div>` în jurul h1/p → trebuie `<div class="df-page-titles">`
   - `class="df-page-title"` pe h1 + `class="df-page-subtitle"` pe p → eliminate (selectorii din shell.css sunt `.df-page-titles h1` și `.df-page-titles p`)

2. **Admin — secțiune concediu iese din modal** — am folosit `.grid2` (2 coloane = inputs late) într-un modal cu `max-width:680px` unde restul folosește `grid-template-columns:1fr 1fr 1fr` (3 coloane = inputs înguste). Plus selectul Delegat și textarea cu `width:100%` au lățimea completă (~620px), ies vizual.
   - Decizie design: **layout B** — Start și Sfârșit pe 2 coloane, Delegat pe 1 coloană (continuare pattern din restul modal-ului), Motivul full-width separat.

## ⛔ CONSTRÂNGERI

1. NU atinge zona STS
2. NU atinge JS-ul (`admin/users.js`, `df-user-modals.js`) — doar HTML
3. NU adăuga reguli CSS noi — folosim doar clasele existente
4. `npm test` verde

---

## FAZA 0 — Pre-checks

```bash
# 0.1 — Confirm bug-ul în setari.html
grep -c "df-main\|df-page-title\|df-page-subtitle" public/setari.html
# Așteptat: ≥ 3 (clasele invalide curente)

grep -c "df-page-titles" public/setari.html
# Așteptat: 0 (clasa corectă lipsește)

# 0.2 — Confirm structura corectă în notifications.html (referință)
grep -c "class=\"df-page-titles\"" public/notifications.html
# Așteptat: 1

grep -c "class=\"df-page\"" public/notifications.html
# Așteptat: 1

# 0.3 — Confirm bug-ul în admin.html
grep -c "class=\"grid2\"" public/admin.html
# Notează numărul (vom modifica DOAR cel din secțiunea concediu)

grep -c "id=\"eLeaveStart\"" public/admin.html
# Așteptat: 1 (secțiunea de fix)
```

---

## FAZA 1 — Fix `setari.html` (header)

### 1.1. Înlocuire `<main class="df-main">` → `<div class="df-page">`

**Caută** (linia 56):
```html
  <main class="df-main">
    <header class="df-page-header">
      <div>
        <h1 class="df-page-title">Setări</h1>
        <p class="df-page-subtitle">Preferințe cont și opțiuni personale</p>
      </div>
```

**Înlocuiește cu:**
```html
  <div class="df-page">
    <header class="df-page-header">
      <div class="df-page-titles">
        <h1>Setări</h1>
        <p>Preferințe cont și opțiuni personale</p>
      </div>
```

### 1.2. Înlocuire închidere `</main>` → `</div>`

**Caută** (linia 122):
```html
    </section>
  </main>
</div>
```

**Înlocuiește cu:**
```html
    </section>
  </div>
</div>
```

NB: comentariu opțional pe a 2-a `</div>` — `</div><!-- /.df-page -->` e fine, dar nu necesar. Lăsăm cum e.

### 1.3. Verificare

```bash
grep -c "df-main\|df-page-title\b\|df-page-subtitle" public/setari.html
# Așteptat: 0 (clasele invalide eliminate)

grep -c "df-page-titles" public/setari.html
# Așteptat: 1

grep -c "class=\"df-page\"" public/setari.html
# Așteptat: 1

grep -c "<main\|</main>" public/setari.html
# Așteptat: 0 (nu mai folosim <main> — folosim <div class="df-page">)
```

---

## FAZA 2 — Fix `admin.html` (secțiune concediu — layout 2+1+full)

**Fișier:** `public/admin.html`

**Caută** blocul exact (linii 1288-1299):
```html
    <div class="grid2">
      <div class="frow"><label>Început concediu</label><input type="date" id="eLeaveStart"/></div>
      <div class="frow"><label>Sfârșit concediu</label><input type="date" id="eLeaveEnd"/></div>
    </div>
    <div class="frow" style="margin-top:12px;">
      <label>Delegat (cine semnează în lipsă)</label>
      <select id="eLeaveDelegate"><option value="">— Niciun delegat —</option></select>
    </div>
    <div class="frow" style="margin-top:12px;">
      <label>Motiv (opțional)</label>
      <textarea id="eLeaveReason" rows="2" maxlength="500" placeholder="Ex: Concediu de odihnă" style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:10px;color:var(--text);font-size:.88rem;outline:none;font-family:inherit;resize:vertical;line-height:1.5;box-sizing:border-box;"></textarea>
    </div>
```

**Înlocuiește cu** (4 coloane: 1+1+2 pentru rândul 1 → start mic, end mic, delegat mai larg; rândul 2 = motiv full-width):

```html
    <!-- Layout: Start (1fr) | Sfârșit (1fr) | Delegat (2fr) — pe un rând -->
    <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:12px;">
      <div class="frow"><label>Început concediu</label><input type="date" id="eLeaveStart"/></div>
      <div class="frow"><label>Sfârșit concediu</label><input type="date" id="eLeaveEnd"/></div>
      <div class="frow">
        <label>Delegat (cine semnează în lipsă)</label>
        <select id="eLeaveDelegate"><option value="">— Niciun delegat —</option></select>
      </div>
    </div>
    <div class="frow" style="margin-top:12px;">
      <label>Motiv (opțional)</label>
      <textarea id="eLeaveReason" rows="2" maxlength="500" placeholder="Ex: Concediu de odihnă" style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:10px;color:var(--text);font-size:.88rem;outline:none;font-family:inherit;resize:vertical;line-height:1.5;box-sizing:border-box;"></textarea>
    </div>
```

**De ce `1fr 1fr 2fr`** și nu strict 1+1+1:
- Datele (Start/Sfârșit) sunt scurte (10 caractere) — încap confortabil în 1fr
- Delegatul are nume lungi („Barbu Ilie Mircea — Director Executiv") — are nevoie de 2× lățimea unei date
- Motivul rămâne full-width pe rând separat (textarea, nevoie de spațiu)

**De ce inline `style="display:grid;..."` și nu o clasă CSS nouă** (gen `.grid-1-1-2`):
- Clasa nouă ar fi singura folosire în tot proiectul
- Inline-style e exact pattern-ul folosit deja în 3-coloane existente din modal (`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">` linia 1247)
- Consistență cu codul existent — nu introducem un nou pattern arhitectural

---

## FAZA 3 — Verificări finale

```bash
# 3.1 — setari.html curat
grep -c "df-main\|df-page-title\b\|df-page-subtitle" public/setari.html
# Așteptat: 0

grep -c "df-page-titles" public/setari.html
# Așteptat: 1

# 3.2 — admin.html secțiune nouă cu layout corect
grep -c "grid-template-columns:1fr 1fr 2fr" public/admin.html
# Așteptat: 1 (singurul nou)

grep -c "class=\"grid2\"" public/admin.html
# Așteptat: să fie cu 1 mai puțin decât pre-check 0.3 (cel din secțiunea concediu eliminat)

# 3.3 — Ids păstrate (admin/users.js NU trebuie modificat)
for id in eLeaveStart eLeaveEnd eLeaveDelegate eLeaveReason eLeaveMsg eLeaveStatusBadge; do
  cnt=$(grep -c "id=\"$id\"" public/admin.html)
  echo "$id: $cnt"
done
# Așteptat: fiecare = 1
```

---

## FAZA 4 — Test + commit + push

```bash
npm test
# Așteptat: toate verzi (modificări doar HTML — nu afectează teste)

git add public/setari.html public/admin.html

git commit -m "fix(ui): hotfix header /setari + layout secțiune concediu admin

Bug 1 — /setari header inconsistent:
- <main class='df-main'> înlocuit cu <div class='df-page'> (.df-main nu există)
- <div> în jurul h1/p înlocuit cu <div class='df-page-titles'>
- class='df-page-title' și 'df-page-subtitle' eliminate de pe h1/p
  (selectorii corecți sunt .df-page-titles h1 și .df-page-titles p)
- Acum identic cu pattern-ul din notifications.html, templates.html

Bug 2 — admin secțiune concediu iese din modal (max-width:680px):
- .grid2 (2 coloane = inputs late) înlocuit cu grid 1fr 1fr 2fr
- Layout nou: Start | Sfârșit | Delegat pe un singur rând
  (Delegatul primește 2× lățime pentru nume lungi)
- Motivul rămâne full-width pe rând separat
- Inline-style consistent cu pattern-ul 1fr 1fr 1fr folosit deja în modal

ID-urile elementelor (eLeaveStart, etc.) PĂSTRATE — admin/users.js
funcționează fără modificări.
"

git push origin develop
```

---

## REZUMAT HOTFIX

**Fișiere atinse:** 2 (`public/setari.html`, `public/admin.html`)
**Linii modificate:** ~15
**Fișiere STS:** 0

## Test manual recomandat

1. **`/setari`** — header arată identic cu `/notifications` (font, padding, alinierea user-trigger la dreapta)
2. **Admin → Editează utilizator** — secțiunea concediu se încadrează în lățimea modal-ului (680px), pe un rând: Start | Sfârșit | Delegat
3. **Pe mobile** (< 640px) — grid 1fr 1fr 2fr se va comporta similar cu cel 1fr 1fr 1fr existent (browserele moderne recompun grid-uri responsive prin `auto-fit`/`flex-wrap`, nu strică nimic)
