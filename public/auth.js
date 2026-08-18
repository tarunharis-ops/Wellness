(function () {
  'use strict';

  function api(pathname, opts) {
    opts = opts || {};
    return fetch(pathname, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data: data });
        return data;
      });
    });
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  function shell(title, sub, bodyHtml) {
    return '' +
      '<div class="auth-card">' +
        '<div class="auth-brand"><span class="brand-mark">W</span> Wellness Tracker</div>' +
        '<div class="auth-title">' + escapeHtml(title) + '</div>' +
        (sub ? '<div class="auth-sub">' + sub + '</div>' : '') +
        bodyHtml +
      '</div>';
  }

  function showAuth(html) {
    el('authRoot').innerHTML = html;
    el('authRoot').style.display = 'flex';
    el('app').style.display = 'none';
  }

  function showApp() {
    el('authRoot').style.display = 'none';
    el('app').style.display = 'flex';
  }

  function bindErrorBox(formId) {
    return function (err) {
      var box = document.querySelector('#' + formId + ' .auth-error');
      if (box) box.textContent = (err.data && err.data.error) || err.message;
    };
  }

  function renderSetup() {
    showAuth(shell('Set up your workspace', 'Create the first admin account. Everyone after this joins by invite.', '' +
      '<form id="setupForm">' +
        '<div class="auth-error"></div>' +
        '<div class="form-field"><label>Your name</label><input type="text" name="name" required /></div>' +
        '<div class="form-field"><label>Email</label><input type="email" name="email" required /></div>' +
        '<div class="form-field"><label>Password</label><input type="password" name="password" minlength="8" required /></div>' +
        '<div class="small-muted" style="margin-bottom:14px">At least 8 characters.</div>' +
        '<button class="btn primary full-width" type="submit">Create workspace</button>' +
      '</form>'
    ));
    el('setupForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      api('/api/auth/setup', { method: 'POST', body: { name: f.name.value, email: f.email.value, password: f.password.value } })
        .then(function (d) { onAuthenticated(d.user); })
        .catch(bindErrorBox('setupForm'));
    });
  }

  function renderLogin(noticeHtml) {
    showAuth(shell('Sign in', 'Invite-only — ask your admin for an invite link if you don\'t have an account yet.', '' +
      (noticeHtml || '') +
      '<form id="loginForm">' +
        '<div class="auth-error"></div>' +
        '<div class="form-field"><label>Email</label><input type="email" name="email" required autofocus /></div>' +
        '<div class="form-field"><label>Password</label><input type="password" name="password" required /></div>' +
        '<button class="btn primary full-width" type="submit">Sign in</button>' +
      '</form>'
    ));
    el('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      api('/api/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } })
        .then(function (d) { onAuthenticated(d.user); })
        .catch(bindErrorBox('loginForm'));
    });
  }

  function renderAcceptInvite(token) {
    api('/api/invites/' + encodeURIComponent(token) + '/check').then(function (info) {
      showAuth(shell('You\'ve been invited', 'Create your account to join the shared workspace' + (info.role === 'admin' ? ' as an admin.' : '.'), '' +
        '<form id="inviteForm">' +
          '<div class="auth-error"></div>' +
          '<div class="form-field"><label>Your name</label><input type="text" name="name" required autofocus /></div>' +
          '<div class="form-field"><label>Email</label><input type="email" name="email" value="' + escapeHtml(info.email || '') + '" ' + (info.email ? 'readonly' : 'required') + ' /></div>' +
          '<div class="form-field"><label>Password</label><input type="password" name="password" minlength="8" required /></div>' +
          '<div class="small-muted" style="margin-bottom:14px">At least 8 characters.</div>' +
          '<button class="btn primary full-width" type="submit">Create account</button>' +
        '</form>'
      ));
      el('inviteForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        api('/api/auth/accept-invite', { method: 'POST', body: { token: token, name: f.name.value, email: f.email.value, password: f.password.value } })
          .then(function (d) { onAuthenticated(d.user); })
          .catch(bindErrorBox('inviteForm'));
      });
    }).catch(function (err) {
      renderLogin('<div class="auth-notice err">' + escapeHtml(err.data ? err.data.error : err.message) + '</div>');
    });
  }

  function onAuthenticated(user) {
    var url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.pathname);
    showApp();
    window.WCT_APP.start(user);
  }

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).then(function () {
      window.location.reload();
    });
  }

  function boot() {
    var inviteToken = new URL(window.location.href).searchParams.get('invite');
    api('/api/auth/status').then(function (status) {
      if (status.user) { showApp(); window.WCT_APP.start(status.user); return; }
      if (status.setupRequired) return renderSetup();
      if (inviteToken) return renderAcceptInvite(inviteToken);
      return renderLogin();
    }).catch(function (err) {
      showAuth(shell('Can\'t reach the server', '<span class="auth-notice err">' + escapeHtml(err.message) + '</span>', ''));
    });
  }

  window.WCT_AUTH = { boot: boot, logout: logout };
  boot();
})();
