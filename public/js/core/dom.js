/**
 * public/js/core/dom.js — DOM utilities for DocFlowAI v4
 */

export const $ = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

export function show(el) { el?.classList.remove('hidden'); }
export function hide(el) { el?.classList.add('hidden'); }
export function toggle(el, visible) { el?.classList.toggle('hidden', !visible); }

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.dataset.origText ??= btn.textContent;
  btn.textContent = loading ? 'Se încarcă...' : btn.dataset.origText;
}

export function clearErrors(form) {
  form?.querySelectorAll('.field-error').forEach(el => el.remove());
  form?.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
}

export function showFieldErrors(form, errors = {}) {
  clearErrors(form);
  for (const [field, msg] of Object.entries(errors)) {
    const input = form?.querySelector(`[name="${field}"], #${field}`);
    if (!input) continue;
    input.classList.add('error');
    const errEl = document.createElement('span');
    errEl.className = 'field-error';
    errEl.textContent = msg;
    input.parentNode.insertBefore(errEl, input.nextSibling);
  }
}

export function getFormData(form) {
  const data = {};
  new FormData(form).forEach((v, k) => {
    if (k in data) {
      data[k] = [].concat(data[k], v);
    } else {
      data[k] = v;
    }
  });
  return data;
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(iso, opts = {}) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ro-RO', {
    year: 'numeric', month: '2-digit', day: '2-digit', ...opts,
  });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ro-RO', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function statusBadge(status) {
  const map = {
    completed:   ['badge-success',  'Finalizat'],
    in_progress: ['badge-info',     'În curs'],
    active:      ['badge-info',     'Activ'],
    draft:       ['badge-neutral',  'Ciornă'],
    refused:     ['badge-danger',   'Refuzat'],
    cancelled:   ['badge-neutral',  'Anulat'],
    pending:     ['badge-warning',  'În așteptare'],
    generated:   ['badge-success',  'Generat'],
  };
  const [cls, label] = map[status] || ['badge-neutral', status ?? '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
