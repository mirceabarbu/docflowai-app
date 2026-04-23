// JS specific login.html — autentificare + auto-redirect dacă user deja logat.
// Rulează sincron la final de <body> (fără defer) pentru a prinde cookie-ul HttpOnly
// imediat și a redirecționa user-ul autentificat fără flash al ecranului de login.
// SEC-01: token în cookie HttpOnly, credentials:'include' pe toate fetch-urile.

  const $=id=>document.getElementById(id);
  // SEC-01: token-ul este în cookie HttpOnly — nu mai verificăm localStorage
  // Verificăm autentificarea cu /auth/me (cookie trimis automat)
  fetch("/auth/me", { credentials: 'include' })
    .then(r=>r.ok?r.json():null)
    .then(u=>{if(u&&u.userId)location.href=(u.role==="admin"||u.role==="org_admin")?"/admin":"/"})
    .catch(()=>{});

  function showErr(msg){const el=$("errMsg");el.textContent=msg;el.style.display="block";}
  async function login(){
    const email=$("email").value.trim(),password=$("password").value;
    const btn=$("btnLogin");
    $("errMsg").style.display="none";
    if(!email||!password){showErr("Completează emailul și parola.");return;}
    btn.disabled=true;btn.innerHTML='<span class="spin"></span>Se verifică...';
    try{
      // SEC-01: credentials: include — serverul setează cookie HttpOnly auth_token
      const r=await fetch("/auth/login",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        credentials: 'include',
        body:JSON.stringify({email,password})
      });
      const d=await r.json();
      if(!r.ok){
        if(d.error==="too_many_attempts"){
          const min=Math.ceil((d.remainSec||900)/60);
          showErr(`⛔ Prea multe încercări eșuate. Contul este blocat temporar. Încearcă din nou în ${min} minute.`);
          let sec=d.remainSec||900;
          const iv=setInterval(()=>{
            sec--;
            if(sec<=0){clearInterval(iv);$("errMsg").style.display="none";return;}
            const m2=Math.floor(sec/60),s2=sec%60;
            $("errMsg").textContent=`⛔ Prea multe încercări eșuate. Încearcă din nou în ${m2}:${String(s2).padStart(2,"0")}.`;
          },1000);
          return;
        }
        const m={invalid_credentials:"Email sau parolă incorectă.",db_not_ready:"Baza de date nu este disponibilă."};
        showErr(m[d.error]||"Eroare de autentificare.");return;
      }
      // SEC-01: token-ul este în cookie HttpOnly setat de server — nu în d.token
      // Stocăm doar datele non-sensibile pentru UI
      localStorage.setItem("docflow_user",JSON.stringify({email:d.email,role:d.role,nume:d.nume,functie:d.functie,institutie:d.institutie||"",compartiment:d.compartiment||""}));
      // Curățăm orice token vechi din localStorage (migrare de la versiunile anterioare)
      localStorage.removeItem("docflow_token");
      if(d.force_password_change) localStorage.setItem("docflow_force_pwd","1");
      else localStorage.removeItem("docflow_force_pwd");
      const next=new URLSearchParams(location.search).get("next");
      location.href=(d.role==="admin"||d.role==="org_admin")?(next&&next.startsWith("/admin")?next:"/admin"):(next||"/");
    }catch(e){showErr("Eroare de rețea.");}
    finally{btn.disabled=false;btn.textContent="Intră în cont";}
  }
  $("btnLogin").addEventListener("click",login);
  $("password").addEventListener("keydown",e=>{if(e.key==="Enter")login();});
  $("email").addEventListener("keydown",e=>{if(e.key==="Enter")$("password").focus();});
