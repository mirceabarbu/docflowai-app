/**
 * public/js/modules/initiator/flow-create.js — 3-step flow creation wizard
 */

import { api }   from '../../core/api.js';
import { toast } from '../../core/toast.js';
import { modal } from '../../core/modal.js';
import { $, $$, show, hide, esc, setLoading, clearErrors, showFieldErrors } from '../../core/dom.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentStep = 1;
let signers     = [];
let uploadedFile = null;

// ── Step navigation ───────────────────────────────────────────────────────────

function goToStep(n) {
  if (n < 1 || n > 3) return;
  currentStep = n;

  $$('.wizard-step').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === n);
    el.classList.toggle('done',   i + 1 <  n);
  });
  $$('.wizard-panel').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === n);
  });

  $('#step-prev')?.classList.toggle('hidden', n === 1);
  const nextBtn = $('#step-next');
  const submitBtn = $('#step-submit');
  if (nextBtn)   nextBtn.classList.toggle('hidden', n === 3);
  if (submitBtn) submitBtn.classList.toggle('hidden', n !== 3);

  // Populate review on step 3
  if (n === 3) populateReview();
}

function nextStep() {
  if (currentStep === 1 && !validateStep1()) return;
  if (currentStep === 2 && !validateStep2()) return;
  goToStep(currentStep + 1);
}

function prevStep() { goToStep(currentStep - 1); }

// ── Step 1 validation ─────────────────────────────────────────────────────────

function validateStep1() {
  const title    = $('#flow-title')?.value?.trim();
  const docType  = $('#flow-doc-type')?.value;
  clearErrors($('#wizard-step1'));

  if (!title || title.length < 3) {
    showFieldErrors($('#wizard-step1'), { 'flow-title': 'Titlul trebuie să aibă cel puțin 3 caractere.' });
    return false;
  }
  if (!docType) {
    showFieldErrors($('#wizard-step1'), { 'flow-doc-type': 'Selectați tipul documentului.' });
    return false;
  }
  return true;
}

// ── Step 2 — Signers ──────────────────────────────────────────────────────────

function validateStep2() {
  if (signers.length === 0) {
    toast.warning('Adăugați cel puțin un semnatar.');
    return false;
  }
  return true;
}

function renderSigners() {
  const container = $('#signers-list');
  if (!container) return;

  if (signers.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted mt-2">Niciun semnatar adăugat.</p>';
    return;
  }

  container.innerHTML = signers.map((s, i) => `
    <div class="signer-item" data-index="${i}">
      <div class="signer-order">${i + 1}</div>
      <div class="signer-info">
        <div class="signer-name">${esc(s.name || s.email)}</div>
        <div class="signer-email">${esc(s.email)}${s.role ? ` — ${esc(s.role)}` : ''}</div>
      </div>
      <div class="signer-actions">
        <button class="btn-icon" onclick="window.flowWizard.moveSigner(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Sus">↑</button>
        <button class="btn-icon" onclick="window.flowWizard.moveSigner(${i}, 1)" ${i === signers.length - 1 ? 'disabled' : ''} title="Jos">↓</button>
        <button class="btn-icon" style="color:var(--color-danger)" onclick="window.flowWizard.removeSigner(${i})" title="Elimină">✕</button>
      </div>
    </div>
  `).join('');
}

function addSigner() {
  const email = $('#signer-email')?.value?.trim();
  const name  = $('#signer-name')?.value?.trim();
  const role  = $('#signer-role')?.value?.trim();
  const fn    = $('#signer-function')?.value?.trim();

  if (!email || !email.includes('@')) {
    toast.warning('Introduceți un email valid pentru semnatar.');
    return;
  }
  if (!name || name.length < 2) {
    toast.warning('Introduceți numele semnatarului (minim 2 caractere).');
    return;
  }
  if (signers.some(s => s.email.toLowerCase() === email.toLowerCase())) {
    toast.warning('Semnatarul este deja în listă.');
    return;
  }
  if (signers.length >= 10) {
    toast.warning('Maxim 10 semnatari per flux.');
    return;
  }

  signers.push({ email, name, role: role || null, function: fn || null });
  renderSigners();

  // Clear inputs
  ['signer-email','signer-name','signer-role','signer-function'].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.value = '';
  });
  $('#signer-email')?.focus();
}

function moveSigner(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= signers.length) return;
  [signers[i], signers[j]] = [signers[j], signers[i]];
  renderSigners();
}

function removeSigner(i) {
  signers.splice(i, 1);
  renderSigners();
}

// ── Step 3 — Upload & Review ──────────────────────────────────────────────────

function initUploadZone() {
  const zone  = $('#upload-zone');
  const input = $('#pdf-upload-input');
  if (!zone || !input) return;

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  });

  input.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file);
  });
}

function handleFileSelect(file) {
  if (file.type !== 'application/pdf') {
    toast.error('Selectați un fișier PDF valid.');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    toast.error('Fișierul depășește limita de 50 MB.');
    return;
  }
  uploadedFile = file;

  const preview = $('#file-preview');
  if (preview) {
    preview.innerHTML = `
      <div class="flex items-center gap-2 p-3 card mt-2">
        <span style="font-size:1.5rem">📄</span>
        <div>
          <div class="font-medium text-sm">${esc(file.name)}</div>
          <div class="text-sm text-muted">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
        </div>
        <button class="btn btn-sm btn-ghost" style="margin-left:auto" id="remove-file-btn">✕ Elimină</button>
      </div>
    `;
    $('#remove-file-btn')?.addEventListener('click', () => {
      uploadedFile = null;
      preview.innerHTML = '';
      $('#pdf-upload-input').value = '';
    });
  }
}

function populateReview() {
  const title   = $('#flow-title')?.value?.trim() || '—';
  const docType = $('#flow-doc-type')?.value || '—';

  $('#review-title')    && ($('#review-title').textContent    = title);
  $('#review-doc-type') && ($('#review-doc-type').textContent = docType);

  const signersList = $('#review-signers');
  if (signersList) {
    signersList.innerHTML = signers.map((s, i) =>
      `<li>${i + 1}. ${esc(s.name)} &lt;${esc(s.email)}&gt;${s.role ? ` (${esc(s.role)})` : ''}</li>`
    ).join('');
  }

  const fileInfo = $('#review-file');
  if (fileInfo) fileInfo.textContent = uploadedFile ? uploadedFile.name : '(niciun fișier)';
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitFlow() {
  if (!uploadedFile) {
    toast.warning('Selectați documentul PDF înainte de a trimite.');
    goToStep(3);
    return;
  }

  const title    = $('#flow-title')?.value?.trim();
  const docType  = $('#flow-doc-type')?.value || 'tabel';
  const formType = $('#flow-form-type')?.value || 'none';

  const submitBtn = $('#step-submit');
  setLoading(submitBtn, true);

  try {
    // 1. Create flow
    const flowData = await api.post('/api/flows', {
      title,
      doc_name:  uploadedFile.name.replace(/\.pdf$/i, ''),
      doc_type:  docType,
      form_type: formType,
      signers:   signers.map((s, i) => ({
        email:    s.email,
        name:     s.name,
        role:     s.role,
        function: s.function,
        step_order: i,
      })),
    });
    const flowId = flowData.flow?.id || flowData.id;

    // 2. Upload PDF
    const formDataUpload = new FormData();
    formDataUpload.append('file', uploadedFile);
    await api.upload(`/api/flows/${flowId}/document`, formDataUpload);

    // 3. Start flow
    await api.post(`/api/flows/${flowId}/start`);

    toast.success('Flux creat și pornit cu succes!');
    closeWizard();

    // Reload flow list
    window.flowListReload?.();

    // If ALOP form: redirect to formular
    if (formType === 'alop') {
      setTimeout(() => location.href = `/formular.html?flow_id=${flowId}`, 500);
    }
  } catch (err) {
    toast.error(err.message || 'Eroare la crearea fluxului.');
  } finally {
    setLoading(submitBtn, false);
  }
}

// ── Wizard open/close ─────────────────────────────────────────────────────────

function openWizard() {
  signers      = [];
  uploadedFile = null;
  currentStep  = 1;
  $('#wizard-step1 form, #flow-wizard form')?.reset?.();
  renderSigners();
  goToStep(1);
  show($('#flow-wizard'));
  show($('#wizard-backdrop'));
}

function closeWizard() {
  hide($('#flow-wizard'));
  hide($('#wizard-backdrop'));
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Expose globally for HTML onclick handlers
  window.flowWizard = { moveSigner, removeSigner, openWizard, closeWizard };

  initUploadZone();

  $('#new-flow-btn')?.addEventListener('click',   openWizard);
  $('#wizard-close')?.addEventListener('click',   closeWizard);
  $('#wizard-backdrop')?.addEventListener('click', closeWizard);
  $('#step-next')?.addEventListener('click',   nextStep);
  $('#step-prev')?.addEventListener('click',   prevStep);
  $('#step-submit')?.addEventListener('click', submitFlow);
  $('#add-signer-btn')?.addEventListener('click', addSigner);

  // Enter key in signer email triggers add
  $('#signer-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addSigner(); }
  });

  // Autocomplete suggestions for signer email
  let acTimer;
  $('#signer-email')?.addEventListener('input', e => {
    clearTimeout(acTimer);
    const val = e.target.value.trim();
    if (val.length < 2) return;
    acTimer = setTimeout(() => loadEmailSuggestions(val), 300);
  });
});

async function loadEmailSuggestions(search) {
  try {
    const data = await api.get('/api/users', { search, limit: 5 });
    const users = data.users ?? [];
    const datalist = $('#signer-email-suggestions');
    if (!datalist) return;
    datalist.innerHTML = users
      .map(u => `<option value="${esc(u.email)}">${esc(u.name || u.email)}</option>`)
      .join('');
  } catch {
    // Autocomplete is best-effort
  }
}
