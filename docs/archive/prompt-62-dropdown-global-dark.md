---
prompt: 62
titlu: "style(global): lista derulantă a tuturor select-urilor devine dark (o regulă în components.css, exceptând câmpurile-hârtie .di)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX global · consecvență dropdown-uri
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Context (owner)
Lista derulantă nativă a mai multor `<select>`-uri apare cu fundal alb / font default, neconsecvent cu restul proiectului. Cauza: doar unele clase setează `color-scheme:dark` (`.df-filter-select`, `.th-filter`) sau stilează `option` (`.flt-sel`). Multe select-uri sunt „plain", `.dfem-input` (fără `color-scheme`) sau inline fără `color-scheme`.

## Auditul (referință — NU trebuie atinse individual)
**Deja dark (OK):** `.df-filter-select` (admin), `.th-filter` (components), `.flt-sel` (formular — stilează `option`).
**Neconsecvente (fundal alb la dropdown):**
- Plain: `admin.html` #nRole, #eRole, #eLeaveDelegate; `refnec-form.html` monede (rfn-f-moneda-*, rfn-h-moneda), `.rfn-rev-tip`; `registratura.html` #reg-an/#reg-status/#regin-* /#regin-f-*; `setari.html` #ent-scope-type/#ent-parent-org/#ent-scope-id.
- `.dfem-input`: `admin.html` #pr-import-format, #pr-export-format, #pr-export-activ, #pr-export-judet.
- Inline fără `color-scheme`: `admin.html` #pr-judet, #pr-target-campaign, #audit-event-type; `semdoc-signer.html` #delegateUserSelect; `semdoc-initiator.html` #fluxStatusFilter.
**Excepție intenționată:** `.di` (câmpuri-hârtie din documente, ex. `#o-df-sel`) — rămân light (aspect de formular pe hârtie).

## Fix — o singură regulă globală (DRY)
`tokens.css`, `shell.css`, `components.css` se încarcă pe **toate** paginile. Adaugă în **`public/css/df/components.css`** (la final sau lângă stilurile de input) o regulă globală:

```css
/* Dropdown nativ dark pe tot proiectul; excepție: câmpurile-hârtie din documente (.di) rămân light */
select:not(.di){ color-scheme: dark; }
```

Asta rezolvă **toate** select-urile neconsecvente dintr-o singură lovitură (plain, `.dfem-input`, inline), fără a atinge fiecare element și fără a strica `.flt-sel`/`.df-filter-select` (redundant, dar armonios). `.di` rămâne neatins.

**NU** modifica select-urile individual, **NU** șterge stilurile existente de pe clase (evită churn/risc), **NU** atinge `.di`.

## Cache busting + versiune
Modifici `components.css` → trebuie invalidat pe **toate** paginile care-l încarcă:
- Bump `?v=` la `/css/df/components.css` în **fiecare** HTML care îl referă (grep: `components.css?v=` în `public/*.html`) la versiunea nouă unică.
- `public/sw.js`: `CACHE_VERSION` → incrementează de la valoarea curentă.
- `package.json`: următorul patch de la valoarea reală curentă.

```bash
grep -rl "components.css?v=" public/*.html   # listează paginile de bumpuit
```

## Guardrails diff
Atinge: `public/css/df/components.css`, HTML-urile care referă `components.css` (doar linia `?v=`), `public/sw.js`, `package.json`. Fără JS, fără logică.
```bash
git diff --name-only | grep -E "\.mjs$|/js/" && echo "⛔ STOP: nu trebuie atins cod!" || echo "✅ doar CSS/HTML/versiuni"
```

## Verificare (owner, staging)
Deschide dropdown-uri pe pagini diferite (admin outreach, registratură, setări, refnec, semnare) → toate au lista dark, font consecvent. Câmpurile din documentul-hârtie (`.di`) rămân light.

## Final
```bash
git add -A
git commit -m "style(global): select:not(.di) color-scheme dark — dropdown-uri consecvente pe tot proiectul"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
