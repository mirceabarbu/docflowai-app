// DocFlowAI — change-password modal pentru semdoc-signer.html.
// Implementare proprie (NU folosește df-user-modals.js). Extras byte-for-byte la Pas 2.12.
// Notă: diferă de semdoc-initiator/modals.js prin faptul că NU ascunde forcePwdBanner.

function openChangePwdModal(){
  document.getElementById('changePwdModal').style.display='flex';
  document.getElementById('cpCurrent').value=document.getElementById('cpNew').value=document.getElementById('cpConfirm').value='';
  document.getElementById('cpMsg').textContent='';document.getElementById('cpMsg').style.color='';
  document.getElementById('cpBtn').disabled=false;document.getElementById('cpBtn').textContent='Salvează';
  document.getElementById('cpCurrent').focus();
}
function closeChangePwdModal(){document.getElementById('changePwdModal').style.display='none';}
async function submitChangePwd(){
  const cur=document.getElementById('cpCurrent').value;
  const nw=document.getElementById('cpNew').value;
  const cf=document.getElementById('cpConfirm').value;
  const msg=document.getElementById('cpMsg');
  const btn=document.getElementById('cpBtn');
  if(!cur||!nw||!cf){msg.style.color='#f28b82';msg.textContent='Completează toate câmpurile.';return;}
  if(nw!==cf){msg.style.color='#f28b82';msg.textContent='Parolele noi nu coincid.';return;}
  if(nw.length<6){msg.style.color='#f28b82';msg.textContent='Parola trebuie să aibă minim 6 caractere.';return;}
  btn.disabled=true;btn.textContent='Se salvează...';
  try{
    const r=await fetch('/auth/change-password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({current_password:cur,new_password:nw})});
    const d=await r.json();
    if(r.ok){
      msg.style.color='#34A853';msg.textContent='✅ Parola schimbată cu succes!';btn.textContent='Salvează';
      localStorage.removeItem('docflow_force_pwd');
      setTimeout(closeChangePwdModal,1800);
    } else {
      msg.style.color='#f28b82';msg.textContent=d.message||(d.error==='wrong_password'?'Parola curentă incorectă.':'Eroare.');
      btn.disabled=false;btn.textContent='Salvează';
    }
  } catch(e){msg.style.color='#f28b82';msg.textContent='Eroare de rețea.';btn.disabled=false;btn.textContent='Salvează';}
}
