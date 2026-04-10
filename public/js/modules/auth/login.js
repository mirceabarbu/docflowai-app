/**
 * public/js/modules/auth/login.js — Login page logic for DocFlowAI v4
 */

import { api }   from '../../core/api.js';
import { auth }  from '../../core/auth.js';
import { toast } from '../../core/toast.js';
import { $, setLoading, show, hide, clearErrors, showFieldErrors } from '../../core/dom.js';

// Redirect if already logged in
if (auth.isLoggedIn()) {
  location.href = auth.isAdmin() ? '/admin' : '/';
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm   = $('#login-form');
  const mfaSection  = $('#mfa-section');
  const loginSection= $('#login-section');
  const loginError  = $('#login-error');
  const mfaForm     = $('#mfa-form');
  const submitBtn   = $('#login-submit');

  let pendingEmail = '';
  let pendingPass  = '';

  function showError(msg) {
    if (loginError) {
      loginError.textContent = msg;
      show(loginError);
    }
  }
  function clearError() {
    if (loginError) {
      loginError.textContent = '';
      hide(loginError);
    }
  }

  // ── Login form submit ────────────────────────────────────────────────────

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    clearErrors(loginForm);

    const email    = loginForm.querySelector('[name="email"]')?.value?.trim() || '';
    const password = loginForm.querySelector('[name="password"]')?.value || '';

    if (!email)    { showFieldErrors(loginForm, { email: 'Email-ul este obligatoriu.' }); return; }
    if (!password) { showFieldErrors(loginForm, { password: 'Parola este obligatorie.' }); return; }

    setLoading(submitBtn, true);

    try {
      const data = await api.post('/api/auth/login', { email, password });

      if (data?.mfa_required) {
        pendingEmail = email;
        pendingPass  = password;
        hide(loginSection);
        show(mfaSection);
        mfaSection?.querySelector('input')?.focus();
        return;
      }

      if (data?.user) {
        auth.setUser(data.user);
        toast.success('Autentificare reușită!');
        setTimeout(() => {
          location.href = data.user.role === 'admin' || data.user.role === 'org_admin'
            ? '/admin' : '/';
        }, 300);
      }
    } catch (err) {
      if (err.fields) {
        showFieldErrors(loginForm, err.fields);
      } else if (err.status === 429) {
        showError('Prea multe încercări. Așteptați câteva minute și reîncercați.');
      } else if (err.status === 401 || err.status === 400) {
        showError('Email sau parolă incorectă.');
      } else {
        showError(err.message || 'Eroare la autentificare.');
      }
    } finally {
      setLoading(submitBtn, false);
    }
  });

  // ── MFA form submit ──────────────────────────────────────────────────────

  mfaForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code    = mfaForm.querySelector('[name="totp_code"]')?.value?.replace(/\s/g, '') || '';
    const mfaBtn  = mfaForm.querySelector('[type="submit"]');
    clearError();

    if (code.length !== 6) {
      showError('Codul TOTP trebuie să aibă 6 cifre.');
      return;
    }

    setLoading(mfaBtn, true);
    try {
      const data = await api.post('/api/auth/login', {
        email:     pendingEmail,
        password:  pendingPass,
        totp_code: code,
      });
      if (data?.user) {
        auth.setUser(data.user);
        toast.success('Autentificare cu 2FA reușită!');
        setTimeout(() => {
          location.href = data.user.role === 'admin' || data.user.role === 'org_admin'
            ? '/admin' : '/';
        }, 300);
      }
    } catch (err) {
      showError(err.status === 401 ? 'Cod TOTP invalid.' : (err.message || 'Eroare.'));
    } finally {
      setLoading(mfaBtn, false);
    }
  });

  // ── Back to login link ───────────────────────────────────────────────────

  $('#back-to-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    clearError();
    hide(mfaSection);
    show(loginSection);
    pendingEmail = pendingPass = '';
  });

  // Focus email on load
  loginForm?.querySelector('[name="email"]')?.focus();
});
