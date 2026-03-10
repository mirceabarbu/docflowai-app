window.DocFlowApi = {
  async fetch(url, options) {
    const r = await fetch(url, Object.assign({ credentials:'include' }, options || {}));
    if (r.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return r;
  }
};
