/**
 * public/js/core/api.js — HTTP client for DocFlowAI v4
 * ES module — import { api } from './api.js'
 */

export default class Api {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  _getCsrfToken() {
    return document.cookie
      .split(';')
      .find(c => c.trim().startsWith('csrf_token='))
      ?.split('=')[1]
      ?.trim() || '';
  }

  async _request(method, path, { body, params } = {}) {
    const url = new URL(this.baseUrl + path, location.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      });
    }

    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-CSRF-Token': this._getCsrfToken(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) {
      location.href = '/login';
      return;
    }

    const isJson = res.headers.get('content-type')?.includes('json');
    const data   = isJson ? await res.json() : null;

    if (!res.ok) {
      const err = data?.error ?? {};
      throw Object.assign(new Error(err.message || data?.message || 'Eroare server'), {
        status:  res.status,
        code:    err.code,
        fields:  err.fields,
      });
    }

    return data;
  }

  get(path, params)  { return this._request('GET',    path, { params }); }
  post(path, body)   { return this._request('POST',   path, { body }); }
  patch(path, body)  { return this._request('PATCH',  path, { body }); }
  put(path, body)    { return this._request('PUT',    path, { body }); }
  delete(path)       { return this._request('DELETE', path); }

  async upload(path, formData) {
    const res = await fetch(this.baseUrl + path, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'X-CSRF-Token': this._getCsrfToken() },
      body:        formData,
    });

    if (res.status === 401) { location.href = '/login'; return; }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw Object.assign(new Error(data?.error?.message || 'Upload eșuat'), {
        status: res.status,
        ...(data?.error || {}),
      });
    }
    return data;
  }

  async downloadBlob(path, filename) {
    const res = await fetch(this.baseUrl + path, {
      credentials: 'include',
      headers: { 'X-CSRF-Token': this._getCsrfToken() },
    });
    if (!res.ok) throw new Error('Download eșuat');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

export const api = new Api();
