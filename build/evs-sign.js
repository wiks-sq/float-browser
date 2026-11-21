'use strict';
// electron-builder afterSign hook: VMP-sign Windows builds with castLabs EVS.
// Netflix, Disney+ and similar only play Widevine content on Windows (and macOS) in a
// browser carrying a castLabs VMP signature. Linux has no such check, so this only
// runs for Windows builds. It must run after Authenticode signing (hence afterSign).
//
// One-time setup:  pip install --upgrade castlabs-evs
//                  python -m castlabs_evs.account signup   (free account)
// Skip on purpose: set FLOAT_SKIP_EVS=1 (the build still works; protected video won't).
const { execFileSync } = require('child_process');

exports.default = async function evsSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  if ((process.env.FLOAT_SKIP_EVS || process.env.DRIFT_SKIP_EVS) === '1') {
    console.warn('  • EVS signing skipped (FLOAT_SKIP_EVS=1): Netflix/Disney+ will not play in this build.');
    return;
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  try {
    execFileSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
    console.log('  • EVS VMP signature added');
  } catch (err) {
    throw new Error(
      'castLabs EVS signing failed. Install it with `pip install --upgrade castlabs-evs` and sign in with ' +
      '`python -m castlabs_evs.account signup` (or reauth), or set FLOAT_SKIP_EVS=1 to build without ' +
      'protected-video support.\n' + err.message);
  }
};
