// Lazy sign-in windows block (REQ-GAP-09, REQ-GAP-10; 2.4 group auth): the Sign-In for Data
// Origins dialog and the device-code and PKCE flows (features/signin-ui.js). The policy, the token
// vault and the status-bar indicator stay eager (features/signin.js: every request asks the
// policy). Its imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { installSignInUi } from '../features/signin-ui.js';

(globalThis.__lib ??= {})['js-signin'] = { installSignInUi };
