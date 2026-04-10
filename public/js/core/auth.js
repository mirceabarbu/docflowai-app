/**
 * public/js/core/auth.js — Auth helpers for DocFlowAI v4
 */

export const auth = {
  getUser() {
    try { return JSON.parse(localStorage.getItem('dfai_user')); }
    catch { return null; }
  },

  setUser(u) {
    localStorage.setItem('dfai_user', JSON.stringify(u));
  },

  clearUser() {
    localStorage.removeItem('dfai_user');
  },

  isLoggedIn() {
    return this.getUser() !== null;
  },

  isAdmin() {
    const u = this.getUser();
    return u?.role === 'admin' || u?.role === 'superadmin' || u?.role === 'org_admin';
  },

  isSuperAdmin() {
    return this.getUser()?.role === 'admin' || this.getUser()?.role === 'superadmin';
  },

  requireLogin() {
    if (!this.isLoggedIn()) {
      location.href = '/login';
      throw new Error('Not authenticated');
    }
  },

  requireAdmin() {
    this.requireLogin();
    if (!this.isAdmin()) {
      location.href = '/';
      throw new Error('Not authorized');
    }
  },

  logout() {
    this.clearUser();
    location.href = '/login';
  },
};
