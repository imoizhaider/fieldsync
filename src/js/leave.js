// Sign out of this device, after a confirmation that says what happens to the
// work that has not uploaded yet. Used by the Regions and "Sign in again" screens.
import { html, openSheet, go } from './html.js';
import { signOut } from './auth.js';
import { state } from './sync.js';

export function askSignOut() {
  const leave = async (close) => { close(); await signOut(); go('#/signin'); };
  openSheet(html`
    <div class="eyebrow">Sign out</div>
    <h2>Sign out of this device?</h2>
    <p class="muted">${state.pending > 0
      ? `${state.pending} ${state.pending === 1 ? 'change has' : 'changes have'} not uploaded yet. They stay saved on this device and upload after you sign in again.`
      : 'Your records stay on this device. Signing in again needs a connection.'}</p>
    <div class="actions">
      <button class="btn secondary" data-act="keep">Stay signed in</button>
      <button class="btn" data-act="leave">Sign out</button>
    </div>`, { leave });
}
