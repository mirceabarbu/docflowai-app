/**
 * public/js/core/toast.js — Toast notifications for DocFlowAI v4
 * Zero dependencies, inline styles, slide-in from right.
 */

const STYLES = {
  success: { bg: '#16a34a', icon: '✓' },
  error:   { bg: '#dc2626', icon: '✕' },
  warning: { bg: '#d97706', icon: '⚠' },
  info:    { bg: '#0891b2', icon: 'ℹ' },
};

function getContainer() {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    Object.assign(el.style, {
      position:  'fixed',
      top:       '20px',
      right:     '20px',
      zIndex:    '99999',
      display:   'flex',
      flexDirection: 'column',
      gap:       '8px',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  return el;
}

export const toast = {
  show(message, type = 'info', duration = 4000) {
    const cfg = STYLES[type] || STYLES.info;
    const container = getContainer();

    const el = document.createElement('div');
    Object.assign(el.style, {
      display:       'flex',
      alignItems:    'center',
      gap:           '10px',
      padding:       '12px 16px',
      borderRadius:  '8px',
      background:    cfg.bg,
      color:         '#fff',
      fontSize:      '0.875rem',
      fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      boxShadow:     '0 4px 12px rgba(0,0,0,0.15)',
      maxWidth:      '360px',
      pointerEvents: 'all',
      transform:     'translateX(400px)',
      transition:    'transform 0.25s cubic-bezier(0.4,0,0.2,1), opacity 0.25s',
      opacity:       '0',
      cursor:        'pointer',
    });

    const icon = document.createElement('span');
    icon.textContent = cfg.icon;
    Object.assign(icon.style, { fontSize: '1rem', flexShrink: '0', fontWeight: '700' });

    const text = document.createElement('span');
    text.textContent = message;
    Object.assign(text.style, { flex: '1', lineHeight: '1.4' });

    el.appendChild(icon);
    el.appendChild(text);
    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = 'translateX(0)';
        el.style.opacity   = '1';
      });
    });

    const dismiss = () => {
      el.style.transform = 'translateX(400px)';
      el.style.opacity   = '0';
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    };

    el.addEventListener('click', dismiss);
    if (duration > 0) setTimeout(dismiss, duration);

    return dismiss;
  },

  success(msg, dur)  { return this.show(msg, 'success', dur); },
  error(msg, dur)    { return this.show(msg, 'error',   dur ?? 6000); },
  warning(msg, dur)  { return this.show(msg, 'warning', dur); },
  info(msg, dur)     { return this.show(msg, 'info',    dur); },
};
