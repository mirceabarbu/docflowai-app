/**
 * public/js/modules/forms/alop.js — ALOP form for DocFlowAI v4
 * Handles ALOP-2024 form lifecycle: create/load instance, auto-save, validate, generate PDF.
 */

import { api }   from '../../core/api.js';
import { auth }  from '../../core/auth.js';
import { toast } from '../../core/toast.js';
import { modal } from '../../core/modal.js';
import { $, $$, show, hide, esc, setLoading } from '../../core/dom.js';

auth.requireLogin();

// ── State ─────────────────────────────────────────────────────────────────────
const params     = new URLSearchParams(location.search);
const flowId     = params.get('flow_id');
let instanceId   = params.get('instance_id');
let autoSaveTimer = null;
let lastSaveTime  = null;
let isDirty       = false;

// ── Section accordion toggle ──────────────────────────────────────────────────

function initAccordions() {
  $$('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const accordion = header.closest('.accordion');
      const isOpen    = accordion.classList.contains('open');
      // Close all, open clicked
      $$('.accordion').forEach(a => a.classList.remove('open'));
      if (!isOpen) accordion.classList.add('open');
    });
  });
  // Open first section by default
  $$('.accordion')[0]?.classList.add('open');
}

// ── Load or create instance ───────────────────────────────────────────────────

async function initForm() {
  try {
    if (!instanceId) {
      const result = await api.post('/api/forms/alop/create', { flowId: flowId || null });
      instanceId = result.instance?.id;
      if (!instanceId) throw new Error('Nu s-a putut crea instanța formularului.');
      // Update URL without reload
      const url = new URL(location.href);
      url.searchParams.set('instance_id', instanceId);
      history.replaceState(null, '', url);
    }

    // Load existing data if instance already has some
    const inst = await api.get(`/api/forms/instances/${instanceId}`);
    if (inst?.instance?.data_json) {
      populateFormData(inst.instance.data_json);
    }

    startAutoSave();
    updateSaveIndicator('ready');
    toast.info('Formular ALOP încărcat.', 2000);
  } catch (err) {
    toast.error(err.message || 'Eroare la inițializarea formularului.');
  }
}

// ── Collect form data ─────────────────────────────────────────────────────────

function collectData() {
  const data = {};
  $$('[data-field]').forEach(el => {
    const path  = el.dataset.field;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    _setNested(data, path, value);
  });
  return data;
}

function populateFormData(data) {
  $$('[data-field]').forEach(el => {
    const val = _getNested(data, el.dataset.field);
    if (val == null) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val;
  });
  updateTotalValoare();
}

// ── Auto-save ─────────────────────────────────────────────────────────────────

function startAutoSave() {
  autoSaveTimer = setInterval(autoSave, 30_000);
  // Save on every change (debounced)
  $$('[data-field]').forEach(el => {
    el.addEventListener('input',  () => { isDirty = true; updateTotalValoare(); });
    el.addEventListener('change', () => { isDirty = true; });
  });
}

async function autoSave() {
  if (!instanceId || !isDirty) return;
  updateSaveIndicator('saving');
  try {
    const data = collectData();
    await api.put(`/api/forms/instances/${instanceId}/data`, { data });
    isDirty      = false;
    lastSaveTime = new Date();
    updateSaveIndicator('saved');
  } catch {
    updateSaveIndicator('error');
  }
}

function updateSaveIndicator(state) {
  const el = $('#autosave-indicator');
  if (!el) return;

  el.className = 'autosave-indicator';
  if (state === 'saving') {
    el.className += ' saving';
    el.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Se salvează...';
  } else if (state === 'saved' && lastSaveTime) {
    el.className += ' saved';
    el.textContent = `✓ Salvat la ${lastSaveTime.toLocaleTimeString('ro-RO', { hour:'2-digit', minute:'2-digit' })}`;
  } else if (state === 'error') {
    el.textContent = '⚠ Eroare salvare automată';
  } else {
    el.textContent = '';
  }
}

// ── Total calculation (Section B) ─────────────────────────────────────────────

function updateTotalValoare() {
  const valFact = parseFloat($('[data-field="sectionB.valoareFactura"]')?.value || 0) || 0;
  const el      = $('#total-valoare');
  if (el) el.textContent = valFact.toLocaleString('ro-RO', { style: 'currency', currency: 'RON' });
}

// ── Live validation ───────────────────────────────────────────────────────────

function initLiveValidation() {
  $$('[data-field][required]').forEach(el => {
    el.addEventListener('blur', () => {
      const isValid = el.value.trim() !== '';
      el.classList.toggle('error', !isValid);

      let errEl = el.nextElementSibling;
      if (errEl?.classList.contains('field-error')) errEl.remove();

      if (!isValid) {
        const err = document.createElement('span');
        err.className   = 'field-error';
        err.textContent = 'Câmp obligatoriu.';
        el.parentNode.insertBefore(err, el.nextSibling);
      }
    });
  });
}

// ── Validate ──────────────────────────────────────────────────────────────────

async function validateForm() {
  if (!instanceId) return;
  await autoSave(); // save first

  const btn = $('#validate-btn');
  setLoading(btn, true);
  try {
    const result = await api.post(`/api/forms/instances/${instanceId}/validate`);
    if (result.valid) {
      toast.success('Formularul este valid!');
    } else {
      const errCount = Object.keys(result.errors || {}).length;
      toast.warning(`${errCount} câmpuri cu erori. Verificați secțiunile marcate.`);
      highlightErrors(result.errors || {});
    }
    return result.valid;
  } catch (err) {
    toast.error(err.message || 'Eroare la validare.');
    return false;
  } finally {
    setLoading(btn, false);
  }
}

function highlightErrors(errors) {
  // Clear old errors
  $$('[data-field].error').forEach(el => el.classList.remove('error'));
  $$('.field-error').forEach(el => el.remove());

  for (const [field, msg] of Object.entries(errors)) {
    const el = $(`[data-field="${field}"]`);
    if (!el) continue;
    el.classList.add('error');
    const errEl = document.createElement('span');
    errEl.className   = 'field-error';
    errEl.textContent = msg;
    el.parentNode.insertBefore(errEl, el.nextSibling);

    // Open parent accordion
    el.closest('.accordion')?.classList.add('open');
  }
}

// ── Generate PDF ──────────────────────────────────────────────────────────────

async function generatePdf() {
  if (!instanceId) return;

  const valid = await validateForm();
  if (!valid) {
    const proceed = await modal.confirm(
      'Formularul conține erori de validare. Generați PDF-ul oricum?',
      { okText: 'Generează', cancelText: 'Corectați mai întâi' }
    );
    if (!proceed) return;
  }

  const btn = $('#generate-pdf-btn');
  setLoading(btn, true);
  try {
    await api.downloadBlob(
      `/api/forms/instances/${instanceId}/pdf`,
      `ALOP_${instanceId}.pdf`
    );
    toast.success('Formular ALOP generat cu succes!');
  } catch (err) {
    toast.error(err.message || 'Eroare la generarea PDF-ului.');
  } finally {
    setLoading(btn, false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setNested(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] ??= {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function _getNested(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initAccordions();
  initLiveValidation();

  $('#validate-btn')?.addEventListener('click',      validateForm);
  $('#generate-pdf-btn')?.addEventListener('click',  generatePdf);
  $('#save-btn')?.addEventListener('click', async () => {
    isDirty = true;
    await autoSave();
  });

  // Clean up auto-save on page unload
  window.addEventListener('beforeunload', e => {
    if (isDirty) {
      autoSave();
      e.returnValue = 'Aveți modificări nesalvate. Doriți să părăsiți pagina?';
    }
  });

  initForm();
});
