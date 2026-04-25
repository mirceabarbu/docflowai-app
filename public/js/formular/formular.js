// public/js/formular/formular.js — Bootstrap shell (BLOC 2 FINAL)
// Toate modulele formular: public/js/formular/{core,verif,alop,draft,list,doc}.js
//
// Conține DOAR: autentificare async + init pagină + money input DOMContentLoaded.
// Ordinea de încărcare: core → verif → alop → draft → list → doc → formular (ULTIM).

(async()=>{
  try{
    const r=await fetch('/auth/me',{credentials:'include'});
    if(!r.ok){location.href='/login.html';return;}
    ST.user=await r.json();

    // ── userBar identic cu semdoc-initiator ──────────────────────────────
    const bar=document.getElementById('hUserBar');
    if(bar){
      const u=ST.user;
      const label=u.nume||u.email||'';
      bar.innerHTML=(label?`<span>Conectat: <strong>${label}</strong></span>`:'')
        +((u.role==='admin'||u.role==='org_admin')?`<a href="/admin">⚙ Admin</a>`:'')
        +`<button onclick="fetch('/auth/logout',{method:'POST',credentials:'include'}).finally(()=>{localStorage.removeItem('docflow_user');location.href='/login';})">Ieșire</button>`;
    }
  }catch{location.href='/login.html';return;}

  // ── Fetch profil org → stochează în ST.orgProfile pentru re-fill ulterior ──
  // Dacă utilizatorul nu are org (ex: admin super-user), org va fi null —
  // câmpurile rămân editabile fără eroare; nu e nevoie de fallback în JWT.
  try{
    const orgR=await fetch('/api/org/profile',{credentials:'include'});
    if(orgR.ok){
      const body=await orgR.json();
      const org=body?.org||null;
      if(org){
        const compList=org.compartimente_utilizatori&&org.compartimente_utilizatori.length
          ? org.compartimente_utilizatori
          : (org.compartimente||[]);
        ST.orgProfile={name:org.name||'',cif:org.cif||'',_compList:compList};
      }
      // org null → ST.orgProfile rămâne null; câmpurile vor fi editabile manual
    }
  }catch(e){/* non-fatal — câmpurile rămân editabile */}

  // ── Restaurează _alopContext din sessionStorage după reload ─────────────
  if (!window._alopContext) {
    const _saved = sessionStorage.getItem('_alopContext');
    if (_saved) try { window._alopContext = JSON.parse(_saved); } catch(e) {}
  }

  // ── Aplică auto-fill în ambele formulare (condiție: câmpurile goale) ────
  _applyAutoFill('ordnt');
  _applyAutoFill('notafd');
  addOR(); addNV();
})();


// AUTO-SAVE DRAFT + DATE helpers → extrase în draft.js (BLOC 2.3)

// DOC CRUD + VAL + P2 → extrase în doc.js (BLOC 2.5)

// LISTA + BENEF + AUTO-SAVE DB → extrase în list.js (BLOC 2.4)
// ALOP + REVIZIE → extrase în alop.js (BLOC 2.2)
// Verificare furnizor + Formulare oficiale → extrase în verif.js (BLOC 2.1)



// Attach money inputs standalone (Enter listeners → verif.js)
document.addEventListener('DOMContentLoaded', () => {
  ['n-ramana','n-sumfara','n-sumfararezvcrbug','alop-valoare','plata-suma'].forEach(id=>{
    const el=document.getElementById(id);if(el)attachMoneyInput(el);
  });
});

