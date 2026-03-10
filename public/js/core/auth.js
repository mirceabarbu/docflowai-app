window.DocFlowAuth = {
  logout() {
    return fetch('/auth/logout',{method:'POST',credentials:'include'})
      .finally(()=>{ localStorage.removeItem('docflow_token'); localStorage.removeItem('docflow_user'); localStorage.removeItem('docflow_force_pwd'); location.href='/login'; });
  }
};
