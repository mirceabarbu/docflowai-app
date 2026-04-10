/**
 * public/js/core/tables.js — Table and pagination rendering for DocFlowAI v4
 */

/**
 * Render a table into `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   columns: Array<{ key: string, label: string, render?: (val, row) => string }>,
 *   rows: Array<object>,
 *   actions?: Array<{ label: string, class?: string, onClick: (row) => void }>,
 *   emptyMessage?: string
 * }} opts
 */
export function renderTable(container, { columns, rows, actions, emptyMessage = 'Nicio înregistrare.' }) {
  container.innerHTML = '';

  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="table-empty">${emptyMessage}</div>`;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');

  // Head
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.appendChild(th);
  }
  if (actions?.length) {
    const th = document.createElement('th');
    th.textContent = 'Acțiuni';
    th.style.textAlign = 'right';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const value = _get(row, col.key);
      td.innerHTML = col.render ? col.render(value, row) : _esc(value);
      tbody.appendChild(tr);
      tr.appendChild(td);
    }
    if (actions?.length) {
      const td = document.createElement('td');
      td.style.textAlign = 'right';
      td.style.whiteSpace = 'nowrap';
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.className = `btn btn-sm ${action.class || 'btn-ghost'}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          action.onClick(row);
        });
        btnGroup.appendChild(btn);
      }
      td.appendChild(btnGroup);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
  container.appendChild(wrapper);
}

/**
 * Render pagination controls into `container`.
 *
 * @param {HTMLElement} container
 * @param {{ total: number, page: number, limit: number, onPageChange: (page) => void }} opts
 */
export function renderPagination(container, { total, page, limit, onPageChange }) {
  container.innerHTML = '';
  if (total <= limit) return;

  const pages = Math.ceil(total / limit);
  const div   = document.createElement('div');
  div.className = 'pagination';

  const addBtn = (label, targetPage, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.disabled    = disabled;
    if (active) btn.classList.add('active');
    btn.addEventListener('click', () => onPageChange(targetPage));
    div.appendChild(btn);
  };

  addBtn('‹', page - 1, page <= 1);

  // Show up to 7 page buttons with ellipsis
  const pageNums = _pageRange(page, pages);
  let prev = null;
  for (const p of pageNums) {
    if (prev !== null && p - prev > 1) {
      const el = document.createElement('span');
      el.textContent = '…';
      el.style.cssText = 'padding:0 4px;color:#6b7280;font-size:0.8rem;';
      div.appendChild(el);
    }
    addBtn(p, p, false, p === page);
    prev = p;
  }

  addBtn('›', page + 1, page >= pages);

  const info = document.createElement('span');
  info.style.cssText = 'font-size:0.75rem;color:#6b7280;margin-left:8px;';
  const from = (page - 1) * limit + 1;
  const to   = Math.min(page * limit, total);
  info.textContent = `${from}–${to} din ${total}`;
  div.appendChild(info);

  container.appendChild(div);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _get(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

function _esc(v) {
  if (v == null) return '<span style="color:#9ca3af">—</span>';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _pageRange(current, total, delta = 2) {
  const range = new Set([1, total]);
  for (let i = Math.max(2, current - delta); i <= Math.min(total - 1, current + delta); i++) {
    range.add(i);
  }
  return [...range].sort((a, b) => a - b);
}
