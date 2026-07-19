# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): fișierele de semnare STS. Acest prompt nu le atinge.

---

## Obiectiv — Bug 4: org_admin vede modulul „Administrare", fără ștergere de fluxuri

Două sisteme de sidebar:
1. **df-shell** (paginile normale): fiecare pagină are secțiunea „Administrare" cu linkuri
   `/admin#dashboard|utilizatori|organizatii|fluxuri|rapoarte`. `df-shell.js` o ascunde când `!isAdmin`,
   deci **org_admin nu o vede** (bug 4a).
2. **admin.html** (SPA-ul de admin): `admin.js` deja tratează org_admin — ascunde tab-urile Organizații
   (`#org-tab-btn`), GWS, Outreach și blochează filtrele pe instituția lui. Deci în SPA e ok.

Restricția pe **ștergere fluxuri** e **deja enforced pe backend** (rutele `delete-old`, `/admin/flows/clean`,
delete-all sunt `admin`-only → org_admin primește 403). Rămâne UX-ul: ascundem subtab-ul destructiv
„Administrare" din Fluxuri documente pentru org_admin (4b), și ascundem linkul „Organizații" din df-shell
pentru org_admin (management global = doar super-admin, cum am stabilit).

---

## Patch 1 — `public/js/df-shell.js`: arată „Administrare" pentru org_admin, fără „Organizații"

Blocul curent ascunde secțiunea „Administrare" când `!isAdmin`. Îl schimbăm să o ascundă doar pentru
utilizatori normali (`!isAdmin && !isOrgAdmin`), și adăugăm ascunderea linkului `#organizatii` pentru org_admin pur.

**old_str**
```
        if (!isAdmin) {
          document.querySelectorAll('.df-nav-label').forEach(function(l) {
            if (l.textContent.trim() === 'Administrare') {
              l.style.display = 'none';
              if (l.nextElementSibling) l.nextElementSibling.style.display = 'none';
            }
          });
        }
```
**new_str**
```
        if (!isAdmin && !isOrgAdmin) {
          document.querySelectorAll('.df-nav-label').forEach(function(l) {
            if (l.textContent.trim() === 'Administrare') {
              l.style.display = 'none';
              if (l.nextElementSibling) l.nextElementSibling.style.display = 'none';
            }
          });
        }
        // org_admin pur: vede „Administrare", dar NU „Organizații" (management global = super-admin)
        if (isOrgAdmin && !isAdmin) {
          document.querySelectorAll('.df-nav-item').forEach(function(item) {
            var href = item.getAttribute('href') || '';
            if (href.indexOf('/admin#organizatii') !== -1) item.style.display = 'none';
          });
        }
```

> `isOrgAdmin` în df-shell.js include deja admin/superadmin; `isOrgAdmin && !isAdmin` izolează exact
> org_admin (admin/superadmin păstrează „Organizații").

---

## Patch 2 — `public/js/admin/admin.js`: ascunde subtab-ul destructiv „Administrare" (Fluxuri) pentru org_admin

În blocul existent `if(u.role==="org_admin"){ ... }` (unde se ascund deja GWS/Outreach/Organizații),
adaugă ascunderea subtab-ului `flows-admin` (ștergere definitivă / ștergere TOATE / VACUUM — `admin`-only pe backend).

**old_str**
```
      const orgTabBtn=$('org-tab-btn');
      if(orgTabBtn) orgTabBtn.style.display="none";
    }
```
**new_str**
```
      const orgTabBtn=$('org-tab-btn');
      if(orgTabBtn) orgTabBtn.style.display="none";
      // Bug-4b: subtab destructiv „Administrare" din Fluxuri (ștergere/VACUUM) = doar super-admin.
      // Backend-ul oricum 403-ează org_admin; ascundem și în UI să nu vadă butoane care eșuează.
      document.querySelectorAll('[data-subtab="flows-admin"],[data-subview="flows-admin"]')
        .forEach(function(el){ el.style.display="none"; });
    }
```

> `flows-active` rămâne subtab-ul implicit, deci ascunderea lui `flows-admin` nu lasă view-ul gol.

---

## Patch 3 — version bump + cache-busting țintit (rezolvă și drift-ul)

`df-shell.js` e referit în 12 fișiere HTML cu `?v=` driftat (11×`3.9.518`, 1×`3.9.524`); `admin.js` în
`admin.html`. Bump țintit pe numele asset-ului (independent de versiunea curentă) → uniformizează la NEW:

```bash
NEW=3.9.531
node -e "const p=require('./package.json');p.version='$NEW';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
# df-shell.js pe toate paginile (repară și drift-ul 518/524 → toate la NEW)
sed -i -E "s#(df-shell\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
# admin.js doar în admin.html
sed -i -E "s#(js/admin/admin\.js\?v=)[0-9.]+#\1$NEW#g" public/admin.html
grep -roh "df-shell\.js?v=[0-9.]*" public/*.html | sort | uniq -c    # toate → NEW
grep -o "js/admin/admin\.js?v=[0-9.]*" public/admin.html             # → NEW
```

> Nici `df-shell.js`, nici `admin.js` nu sunt în `PRECACHE_ASSETS` → fără bump `CACHE_VERSION`.

---

## Verificări

```bash
node --check public/js/df-shell.js
node --check public/js/admin/admin.js

grep -n "isOrgAdmin && !isAdmin\|/admin#organizatii" public/js/df-shell.js
grep -n "flows-admin" public/js/admin/admin.js

npm test   # frontend-only → verde (800), niciun test atins
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

## ⚠️ Verificare manuală pe staging (esențial — e schimbare de vizibilitate pe rol)

Loghează-te ca **org_admin**:
- Sidebar: secțiunea „Administrare" apare, cu Dashboard / Utilizatori / Fluxuri documente / Rapoarte,
  **fără „Organizații"**.
- `/admin#fluxuri` → subtab-urile „Fluxuri active" + „Arhivare Drive" apar; **„Administrare" (destructiv) NU**.
- (Sanity) `/admin#organizatii` direct în URL → SPA-ul nu expune acțiuni globale (admin.js blochează deja);
  ștergerile de fluxuri rămân 403 pe backend.

Loghează-te ca **admin (super)**:
- Totul neschimbat: „Administrare" complet (inclusiv „Organizații") + subtab-ul „Administrare" prezent.

Loghează-te ca **user normal**:
- Secțiunea „Administrare" rămâne ascunsă (neschimbat).

---

## RAPORT FINAL
- [ ] Versiune → 3.9.531 (package.json + `?v=` df-shell.js [12 fișiere, drift reparat] + admin.js)
- [ ] df-shell.js: „Administrare" vizibil pentru org_admin; „Organizații" ascuns pentru org_admin pur
- [ ] admin.js: subtab `flows-admin` ascuns pentru org_admin (backend deja 403)
- [ ] `npm test` verde (800)
- [ ] staging: org_admin vede Administrare fără Organizații/fără subtab destructiv; admin & user neschimbați
- [ ] diff fără fișiere de semnare
- [ ] commit + push **doar pe develop** → CI verde

Commit sugerat:
```
fix(rbac-ui): org_admin vede modulul Administrare, fără ștergere fluxuri (Bug 4)

- df-shell.js: secțiunea Administrare vizibilă pentru org_admin; linkul Organizații ascuns (global = super-admin)
- admin.js: subtab destructiv flows-admin (ștergere/VACUUM) ascuns pentru org_admin (backend deja admin-only/403)
- cache-bust țintit df-shell.js (uniformizează drift 518/524 → 531) + admin.js
- v3.9.531
```
