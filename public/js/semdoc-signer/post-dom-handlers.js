// DocFlowAI — handlers post-DOM (delegare semnătură, review request).
// Folosește $ și _apiFetch din main.js — TREBUIE încărcat DUPĂ main.js.
// Extras din semdoc-signer.html la Pas 2.12 byte-for-byte.

// ── Delegare semnatura ────────────────────────────────────────────────
      const btnDelegate = $("btnDelegheaza");
      if (btnDelegate) {
        btnDelegate.addEventListener("click", async () => {
          const modal = $("delegateModal");
          if (!modal) return;
          const isOpen = modal.style.display !== "none";
          if (isOpen) { modal.style.display = "none"; return; }
          modal.style.display = "block";
          // Incarca userii din institutie daca nu sunt deja incarcati
          const sel = $("delegateUserSelect");
          if (sel && sel.options.length <= 1) {
            try {
              // SEC-01: token din cookie HttpOnly — eliminat jwtToken
              const r = await _apiFetch('/users');
              if (r.ok) {
                const users = await r.json();
                // Exclude semnatarul curent din lista
                const myEmail = currentFlow?.signers?.[signerIndex]?.email || "";
                users.forEach(u => {
                  if ((u.email || "").toLowerCase() === myEmail.toLowerCase()) return;
                  const opt = document.createElement("option");
                  opt.value = u.email || "";
                  opt.dataset.name = u.nume || "";
                  opt.textContent = (u.nume || u.email) + (u.functie ? " — " + u.functie : "");
                  sel.appendChild(opt);
                });
              }
            } catch(e) { console.warn("Nu s-au putut incarca userii pentru delegare:", e); }
          }
        });
      }
      // Auto-fill email+name din dropdown
      const delegSel = $("delegateUserSelect");
      if (delegSel) {
        delegSel.addEventListener("change", () => {
          const opt = delegSel.options[delegSel.selectedIndex];
          const emailInp = $("delegateEmail");
          const nameInp = $("delegateName");
          if (opt && opt.value) {
            if (emailInp) { emailInp.value = opt.value; emailInp.readOnly = true; emailInp.style.opacity = ".6"; }
            if (nameInp) { nameInp.value = opt.dataset.name || ""; nameInp.readOnly = true; nameInp.style.opacity = ".6"; }
          } else {
            if (emailInp) { emailInp.value = ""; emailInp.readOnly = false; emailInp.style.opacity = "1"; }
            if (nameInp) { nameInp.value = ""; nameInp.readOnly = false; nameInp.style.opacity = "1"; }
          }
        });
      }
      const btnDelegConfirm = $("btnDelegateConfirm");
      if (btnDelegConfirm) {
        btnDelegConfirm.addEventListener("click", async () => {
          const toEmail = ($("delegateEmail")?.value||"").trim();
          const toName = ($("delegateName")?.value||"").trim();
          const reason = ($("delegateReason")?.value||"").trim();
          const statusEl = $("delegateStatus");
          if (!toEmail || !/\S+@\S+\.\S+/.test(toEmail)) { if(statusEl) statusEl.textContent = "❌ Email invalid."; return; }
          if (!reason) { if(statusEl) statusEl.textContent = "❌ Motivul este obligatoriu."; return; }
          btnDelegConfirm.disabled = true; btnDelegConfirm.textContent = "Se procesează...";
          if(statusEl) statusEl.textContent = "";
          try {
            const r = await _apiFetch("/flows/" + encodeURIComponent(flow) + "/delegate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fromToken: token, toEmail, toName, reason })
            });
            const j = await r.json();
            if (j.ok) {
              if(statusEl) statusEl.textContent = "✅ Delegare înregistrată. " + toEmail + " a primit notificare.";
              btnDelegConfirm.textContent = "✓ Delegat";
              if (btnDelegate) btnDelegate.disabled = true;
              // Redirect la notificari: tab 'sign' daca mai are de semnat, altfel 'all'
              setTimeout(async () => {
                try {
                  // SEC-01: token din cookie HttpOnly — eliminat jwtTok
                  const rFlows = await _apiFetch('/my-flows');
                  const jFlows = rFlows.ok ? await rFlows.json() : {};
                  const pending = (jFlows.flows || []).some(f =>
                    (f.signers || []).some(s => s.status === "current" && (s.email||"").toLowerCase() === (localStorage.getItem("docflow_email")||"").toLowerCase())
                  );
                  location.href = "/notifications.html?tab=" + (pending ? "sign" : "all");
                } catch(e) { location.href = "/notifications.html?tab=all"; }
              }, 1500);
            } else {
              if(statusEl) statusEl.textContent = "❌ " + (j.message || j.error || "Eroare");
              btnDelegConfirm.disabled = false;
              btnDelegConfirm.textContent = "✓ Confirmă delegarea";
            }
          } catch(e) {
            if(statusEl) statusEl.textContent = "❌ Eroare rețea: " + e.message;
            btnDelegConfirm.disabled = false;
            btnDelegConfirm.textContent = "✓ Confirmă delegarea";
          }
        });
      }
      // ── Buton Trimite spre revizuire ──────────────────────────────────────
      const btnRevizuire = $("btnRevizuire");
      if (btnRevizuire) {
        btnRevizuire.addEventListener("click", () => {
          const reviewModal = $("reviewModal");
          if (reviewModal) {
            reviewModal.style.display = reviewModal.style.display === "none" ? "block" : "none";
            // Ascunde delegateModal dacă e deschis
            const delegModal = $("delegateModal");
            if (delegModal) delegModal.style.display = "none";
          }
        });
      }
      const btnReviewConfirm = $("btnReviewConfirm");
      if (btnReviewConfirm) {
        btnReviewConfirm.addEventListener("click", async () => {
          const reason = ($("reviewReason")?.value || "").trim();
          const statusEl = $("reviewStatus");
          if (!reason) { if(statusEl) statusEl.textContent = "❌ Motivul este obligatoriu."; return; }
          btnReviewConfirm.disabled = true; btnReviewConfirm.textContent = "Se procesează...";
          if(statusEl) statusEl.textContent = "";
          try {
            const r = await _apiFetch("/flows/" + encodeURIComponent(flow) + "/request-review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token, reason })
            });
            const j = await r.json();
            if (j.ok) {
              if(statusEl) statusEl.textContent = "✅ Documentul a fost trimis spre revizuire. Inițiatorul a fost notificat.";
              btnReviewConfirm.textContent = "✓ Trimis";
              if (btnRevizuire) btnRevizuire.disabled = true;
              setTimeout(() => { location.href = "/notifications.html?tab=all"; }, 1800);
            } else {
              if(statusEl) statusEl.textContent = "❌ " + (j.message || j.error || "Eroare");
              btnReviewConfirm.disabled = false;
              btnReviewConfirm.textContent = "✓ Confirmă trimiterea spre revizuire";
            }
          } catch(e) {
            if(statusEl) statusEl.textContent = "❌ Eroare rețea: " + e.message;
            btnReviewConfirm.disabled = false;
            btnReviewConfirm.textContent = "✓ Confirmă trimiterea spre revizuire";
          }
        });
      }

