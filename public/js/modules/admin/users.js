/**
 * public/js/modules/admin/users.js — User management for DocFlowAI v4 admin panel
 */

import { api }   from '../../core/api.js';
import { auth }  from '../../core/auth.js';
import { toast } from '../../core/toast.js';
import { modal } from '../../core/modal.js';
import { renderTable, renderPagination } from '../../core/tables.js';
import { $, esc, formatDate, statusBadge, setLoading, show, hide, getFormData, clearErrors, showFieldErrors } from '../../core/dom.js';

auth.requireAdmin();

// ── State ─────────────────────────────────────────────────────────────────────
let currentPage  = 1;
const PAGE_LIMIT = 20;
let editingUserId = null;

// ── Load users ────────────────────────────────────────────────────────────────

async function loadUsers() {
  const search = $('#search-users')?.value?.trim() || '';
  const role   = $('#filter-role')?.value || '';
  const status = $('#filter-user-status')?.value || '';

  const container = $('#users-table');
  if (!container) return;
  container.innerHTML = '<div class="loading-overlay"><div class="spinner"></div></div>';

  try {
    const data = await api.get('/api/users', {
      page: currentPage, limit: PAGE_LIMIT,
      search: search || undefined,
      role:   role   || undefined,
      status: status || undefined,
    });

    const users = data.users ?? [];
    const total = data.total ?? users.length;

    renderTable(container, {
      columns: [
        { key: 'name',  label: 'Nume',  render: (v, r) => `<strong>${esc(v || r.email)}</strong><br><span class="text-sm text-muted">${esc(r.email)}</span>` },
        { key: 'role',  label: 'Rol',   render: v => roleBadge(v) },
        { key: 'status',label: 'Status',render: v => statusBadge(v) },
        { key: 'created_at', label: 'Creat', render: v => formatDate(v) },
      ],
      rows:    users,
      actions: [
        { label: 'Editează',        class: 'btn-ghost',  onClick: r => openEditModal(r) },
        { label: 'Reset parolă',    class: 'btn-ghost',  onClick: r => resetPassword(r.id, r.email) },
        { label: 'Force logout',    class: 'btn-ghost',  onClick: r => forceLogout(r.id, r.email) },
        { label: 'Dezactivează',    class: 'btn-danger', onClick: r => deleteUser(r.id, r.email) },
      ],
      emptyMessage: 'Niciun utilizator găsit.',
    });

    renderPagination($('#users-pagination'), {
      total, page: currentPage, limit: PAGE_LIMIT,
      onPageChange: p => { currentPage = p; loadUsers(); },
    });
  } catch (err) {
    container.innerHTML = `<div class="table-empty text-danger">Eroare: ${esc(err.message)}</div>`;
  }
}

// ── Create / Edit modal ───────────────────────────────────────────────────────

function openCreateModal() {
  editingUserId = null;
  const form = $('#user-form');
  if (form) { form.reset(); clearErrors(form); }
  $('#user-modal-title') && ($('#user-modal-title').textContent = 'Utilizator nou');
  show($('#user-modal'));
  form?.querySelector('[name="email"]')?.focus();
}

async function openEditModal(user) {
  editingUserId = user.id;
  const form = $('#user-form');
  if (!form) return;
  form.reset();
  clearErrors(form);

  $('#user-modal-title') && ($('#user-modal-title').textContent = 'Editare utilizator');

  // Populate fields
  ['email','name','phone','position','department','role'].forEach(k => {
    const el = form.querySelector(`[name="${k}"]`);
    if (el) el.value = user[k] ?? '';
  });

  show($('#user-modal'));
}

async function saveUser() {
  const form = $('#user-form');
  if (!form) return;
  clearErrors(form);

  const data = getFormData(form);
  const btn  = $('#user-save-btn');
  setLoading(btn, true);

  try {
    if (editingUserId) {
      await api.patch(`/api/users/${editingUserId}`, data);
      toast.success('Utilizator actualizat.');
    } else {
      const res = await api.post('/api/users', data);
      if (res?.tempPassword) {
        toast.info(`Utilizator creat. Parolă temporară: ${res.tempPassword}`, 0);
      } else {
        toast.success('Utilizator creat.');
      }
    }
    closeUserModal();
    loadUsers();
  } catch (err) {
    if (err.fields) showFieldErrors(form, err.fields);
    else toast.error(err.message || 'Eroare la salvare.');
  } finally {
    setLoading(btn, false);
  }
}

function closeUserModal() {
  hide($('#user-modal'));
  editingUserId = null;
}

// ── Reset password ────────────────────────────────────────────────────────────

async function resetPassword(id, email) {
  const ok = await modal.confirm(`Resetați parola pentru ${email}?\n\nO parolă temporară va fi generată și trimisă pe email.`, {
    okText: 'Resetează parola', cancelText: 'Anulează',
  });
  if (!ok) return;

  try {
    await api.post(`/api/admin/users/${id}/reset-password`);
    toast.success('Parolă resetată. Utilizatorul a primit email-ul.');
  } catch (err) {
    toast.error(err.message || 'Eroare la resetarea parolei.');
  }
}

// ── Force logout ──────────────────────────────────────────────────────────────

async function forceLogout(id, email) {
  const ok = await modal.confirm(`Invalidați toate sesiunile active pentru ${email}?`);
  if (!ok) return;

  try {
    await api.post(`/api/admin/users/${id}/force-logout`);
    toast.success('Sesiuni invalidate.');
  } catch (err) {
    toast.error(err.message || 'Eroare.');
  }
}

// ── Delete (soft) ─────────────────────────────────────────────────────────────

async function deleteUser(id, email) {
  const ok = await modal.confirm(`Dezactivați contul ${email}?\nAcesta nu va mai putea accesa aplicația.`, {
    title: 'Dezactivare cont', okText: 'Dezactivează',
  });
  if (!ok) return;

  try {
    await api.delete(`/api/users/${id}`);
    toast.success('Utilizator dezactivat.');
    loadUsers();
  } catch (err) {
    toast.error(err.message || 'Eroare la ștergere.');
  }
}

// ── CSV import ────────────────────────────────────────────────────────────────

async function importCsv(file) {
  const formData = new FormData();
  formData.append('file', file);

  const btn = $('#import-csv-btn');
  setLoading(btn, true);
  try {
    const result = await api.upload('/api/users/bulk-import', formData);
    const msg = `Importat: ${result.created} creați, ${result.skipped} existenți${result.errors?.length ? `, ${result.errors.length} erori` : ''}.`;
    toast.success(msg, 7000);
    if (result.errors?.length) {
      console.warn('Erori import CSV:', result.errors);
    }
    loadUsers();
  } catch (err) {
    toast.error(err.message || 'Eroare la import CSV.');
  } finally {
    setLoading(btn, false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function roleBadge(role) {
  const map = {
    admin:      ['badge-danger',  'Super Admin'],
    superadmin: ['badge-danger',  'Super Admin'],
    org_admin:  ['badge-warning', 'Admin Org'],
    user:       ['badge-neutral', 'Utilizator'],
  };
  const [cls, label] = map[role] || ['badge-neutral', role ?? '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// ── Wire up events ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Initial load handled by section switching in admin dashboard
  // Exposed globally so admin.html section nav can trigger it
  window.usersModule = { loadUsers, openCreateModal };

  $('#create-user-btn')?.addEventListener('click', openCreateModal);
  $('#user-save-btn')?.addEventListener('click',   saveUser);
  $('#user-cancel-btn')?.addEventListener('click', closeUserModal);
  $('#user-modal-close')?.addEventListener('click', closeUserModal);

  // Close on backdrop click
  $('#user-modal')?.addEventListener('click', e => {
    if (e.target === $('#user-modal')) closeUserModal();
  });

  // Search / filter
  let searchTimer;
  $('#search-users')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { currentPage = 1; loadUsers(); }, 350);
  });
  $('#filter-role')?.addEventListener('change',       () => { currentPage = 1; loadUsers(); });
  $('#filter-user-status')?.addEventListener('change', () => { currentPage = 1; loadUsers(); });

  // CSV import
  const csvInput = $('#csv-file-input');
  csvInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) { importCsv(file); csvInput.value = ''; }
  });
  $('#import-csv-btn')?.addEventListener('click', () => csvInput?.click());
});
