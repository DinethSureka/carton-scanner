/* Carton Scanner - shared helpers for login, dashboard and users pages */
'use strict';

const CS = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString();
  const homeFor = role => (role === 'User' ? '/' : '/dashboard');

  function toLogin() {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }

  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      return { status: 0, data: { ok: false, error: 'Cannot reach the server. Is the server window still open?' } };
    }
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (r.status === 401 && path !== '/api/login') { toLogin(); }
    if (r.status === 403 && data.mustChangePassword) { toLogin(); }
    return { status: r.status, data };
  }

  /* loads the logged-in user; sends to login if needed; roles = allowed roles */
  async function requireUser(roles) {
    const r = await api('GET', '/api/me');
    if (r.status !== 200) {
      if (r.status === 0 || r.status >= 500) document.body.innerHTML =
        `<main><div class="card"><h1>Server not reachable</h1><p>${esc(r.data.error || 'Please check the server window and try again.')}</p></div></main>`;
      return new Promise(() => {});           // stop here; the page is being redirected
    }
    const u = r.data.user;
    if (u.mustChangePassword) { toLogin(); return new Promise(() => {}); }
    if (roles && !roles.includes(u.role)) { location.replace(homeFor(u.role)); return new Promise(() => {}); }
    return u;
  }

  function header(user, active) {
    const links = [['/', 'Scanner', 'scanner'], ['/dashboard', 'Dashboard', 'dashboard']];
    if (user.role === 'Admin') links.push(['/users', 'Users', 'users']);
    const initials = (user.fullName || user.userName).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const el = document.createElement('header');
    el.className = 'app-header';
    el.innerHTML = `
      <div class="bar">
        <a href="${homeFor(user.role)}"><img src="/assets/logo.png" alt="Trilogi"></a>
        <nav>${links.map(([h, t, k]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${t}</a>`).join('')}</nav>
        <div class="who">
          <button type="button" aria-haspopup="true"><span class="avatar">${esc(initials)}</span><span class="name">${esc(user.fullName || user.userName)}</span></button>
          <div class="menu hidden">
            <div class="meta"><b>${esc(user.fullName || user.userName)}</b>${esc(user.userName)} · <span class="role ${esc(user.role)}">${esc(user.role)}</span></div>
            <button type="button" data-act="pw">Change password</button>
            <button type="button" data-act="out">Log out</button>
          </div>
        </div>
      </div>`;
    document.body.prepend(el);
    const menu = el.querySelector('.menu');
    el.querySelector('.who > button').onclick = e => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', () => menu.classList.add('hidden'));
    menu.querySelector('[data-act=pw]').onclick = () => changePassword();
    menu.querySelector('[data-act=out]').onclick = logout;
  }

  async function logout() {
    await api('POST', '/api/logout', {});
    location.href = '/login';
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back) close(); });
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    return { el: back.querySelector('.modal'), close };
  }

  function changePassword() {
    const m = modal(`
      <h3>Change password</h3>
      <form>
        <div class="field"><label for="cp1">Current password</label><input type="password" id="cp1" autocomplete="current-password" required></div>
        <div class="field"><label for="cp2">New password</label><input type="password" id="cp2" autocomplete="new-password" required minlength="6"></div>
        <div class="field"><label for="cp3">Repeat new password</label><input type="password" id="cp3" autocomplete="new-password" required></div>
        <div class="alert err hidden"></div>
        <div class="foot"><button type="button" class="btn btn-light" data-x>Cancel</button><button class="btn btn-primary">Save</button></div>
      </form>`);
    const f = m.el.querySelector('form'), err = m.el.querySelector('.alert');
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('#cp1').focus();
    f.onsubmit = async e => {
      e.preventDefault();
      const [a, b, c] = ['#cp1', '#cp2', '#cp3'].map(s => m.el.querySelector(s).value);
      if (b !== c) { err.textContent = 'The new passwords do not match'; err.classList.remove('hidden'); return; }
      const r = await api('POST', '/api/me/password', { currentPassword: a, newPassword: b });
      if (!r.data.ok) { err.textContent = r.data.error || 'Could not change password'; err.classList.remove('hidden'); return; }
      m.close();
      toast('Password changed');
    };
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  return { esc, fmt, api, requireUser, header, modal, toast, homeFor, logout };
})();
