/**
 * public/js/core/modal.js — Modal dialogs for DocFlowAI v4
 * Zero dependencies, inline styles, keyboard accessible.
 */

function buildOverlay() {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position:   'fixed',
    inset:      '0',
    background: 'rgba(0,0,0,0.4)',
    backdropFilter: 'blur(2px)',
    zIndex:     '9999',
    display:    'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding:    '20px',
    animation:  'fadeIn 0.15s ease',
  });

  // Inject keyframe once
  if (!document.getElementById('modal-style')) {
    const s = document.createElement('style');
    s.id = 'modal-style';
    s.textContent = `
      @keyframes fadeIn  { from { opacity:0 } to { opacity:1 } }
      @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
    `;
    document.head.appendChild(s);
  }
  return overlay;
}

function buildDialog(title, body, buttons) {
  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    background:   '#fff',
    borderRadius: '12px',
    padding:      '24px',
    maxWidth:     '440px',
    width:        '100%',
    boxShadow:    '0 20px 60px rgba(0,0,0,0.2)',
    animation:    'slideUp 0.2s ease',
    fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    Object.assign(h.style, { marginBottom: '12px', fontSize: '1.1rem', fontWeight: '600', color: '#111' });
    dialog.appendChild(h);
  }

  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'font-size:0.9rem;color:#374151;line-height:1.5;margin-bottom:20px;';
  if (typeof body === 'string') {
    bodyEl.textContent = body;
  } else {
    dialog.appendChild(body);
  }
  dialog.appendChild(bodyEl);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  for (const btn of buttons) {
    const b = document.createElement('button');
    b.textContent = btn.text;
    Object.assign(b.style, {
      padding:      '8px 18px',
      borderRadius: '8px',
      border:       'none',
      fontSize:     '0.875rem',
      fontWeight:   '500',
      cursor:       'pointer',
      fontFamily:   'inherit',
      background:   btn.primary ? '#2563eb' : '#f3f4f6',
      color:        btn.primary ? '#fff'    : '#374151',
    });
    b.addEventListener('mouseover', () => { b.style.opacity = '0.85'; });
    b.addEventListener('mouseout',  () => { b.style.opacity = '1'; });
    b.addEventListener('click', btn.onClick);
    footer.appendChild(b);
  }
  dialog.appendChild(footer);
  return dialog;
}

export const modal = {
  confirm(message, { title = 'Confirmare', okText = 'Da', cancelText = 'Anulează' } = {}) {
    return new Promise(resolve => {
      const overlay = buildOverlay();
      const close = (val) => { overlay.remove(); resolve(val); };

      const dialog = buildDialog(title, message, [
        { text: cancelText, primary: false, onClick: () => close(false) },
        { text: okText,     primary: true,  onClick: () => close(true)  },
      ]);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', onKey); }
        if (e.key === 'Enter')  { close(true);  document.removeEventListener('keydown', onKey); }
      });
    });
  },

  alert(message, { title = 'Atenție' } = {}) {
    return new Promise(resolve => {
      const overlay = buildOverlay();
      const close = () => { overlay.remove(); resolve(); };

      const dialog = buildDialog(title, message, [
        { text: 'OK', primary: true, onClick: close },
      ]);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Enter') {
          close(); document.removeEventListener('keydown', onKey);
        }
      });
    });
  },

  prompt(message, defaultValue = '', { title = 'Introduceți' } = {}) {
    return new Promise(resolve => {
      const overlay = buildOverlay();
      const close = (val) => { overlay.remove(); resolve(val); };

      const wrapper = document.createElement('div');
      const label   = document.createElement('p');
      label.textContent = message;
      label.style.cssText = 'font-size:0.9rem;color:#374151;line-height:1.5;margin-bottom:12px;';

      const input = document.createElement('input');
      Object.assign(input.style, {
        width: '100%', padding: '8px 12px',
        border: '1px solid #e5e7eb', borderRadius: '8px',
        fontSize: '0.875rem', fontFamily: 'inherit',
        outline: 'none',
      });
      input.value = defaultValue;
      input.addEventListener('focus', () => { input.style.borderColor = '#2563eb'; });
      input.addEventListener('blur',  () => { input.style.borderColor = '#e5e7eb'; });

      wrapper.appendChild(label);
      wrapper.appendChild(input);

      const dialog = buildDialog(title, wrapper, [
        { text: 'Anulează', primary: false, onClick: () => close(null)          },
        { text: 'OK',       primary: true,  onClick: () => close(input.value)   },
      ]);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      setTimeout(() => input.focus(), 50);

      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  close(input.value);
        if (e.key === 'Escape') close(null);
      });
    });
  },
};
