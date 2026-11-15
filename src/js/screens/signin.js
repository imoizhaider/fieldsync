import { html, render, go } from '../html.js';
import { signIn, configured } from '../auth.js';
import { startAutoSync, syncNow } from '../sync.js';

export async function mount(el) {
  render(el, html`
    <div class="signin">
      <section class="brand" aria-hidden="true">
        <div>
          <div class="logo">FieldSync</div>
          <div class="logo-sub">Review console</div>
        </div>
        <h2>Every field edit, merged and accounted for.</h2>
        <dl>
          <div><dt>Offline first</dt><dd>Researchers record with no signal</dd></div>
          <div><dt>Auto sync</dt><dd>Changes upload when a connection returns</dd></div>
          <div><dt>Conflict log</dt><dd>Overwritten values are kept for review</dd></div>
        </dl>
      </section>
      <section class="form">
        <form class="inner" novalidate>
          <div class="logo-block">
            <div class="logo">FieldSync</div>
            <div class="muted small">Field data collection</div>
          </div>
          <div>
            <div class="eyebrow lead-eyebrow">Data lead</div>
            <h1 class="title">Sign in</h1>
          </div>
          <label class="field"><span class="label">Email</span>
            <input name="email" type="email" autocomplete="username" inputmode="email" placeholder="researcher@example.org" required></label>
          <label class="field"><span class="label">Password</span>
            <input name="password" type="password" autocomplete="current-password" required></label>
          <p class="error-text small" role="alert" id="signin-error" hidden></p>
          <button class="btn block" type="submit">Sign in</button>
          <p class="muted small">Your session is saved on this device. Next time fieldsync opens with no signal.</p>
          <div class="spacer"></div>
          <div class="notice hint small"><b>No signal right now?</b> You can still open FieldSync if you signed in on this device before. A first sign-in needs a connection.</div>
        </form>
      </section>
    </div>`);

  const form = el.querySelector('form');
  const error = el.querySelector('#signin-error');
  const button = form.querySelector('button');
  if (!configured) {
    error.hidden = false;
    error.textContent = 'This build has no Supabase project configured. See README.md.';
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      error.hidden = false;
      error.textContent = 'Enter your email and password.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Signing in';
    try {
      await signIn(email, password);
      startAutoSync();
      // Wait briefly for the first pull so the right home screen opens.
      await Promise.race([syncNow(), new Promise((r) => { setTimeout(r, 6000); })]);
      go('#/');
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
  return {};
}
