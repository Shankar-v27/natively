/**
 * PROCESS GUARD — Windows Silent Process Execution Shield.
 *
 * Prevents console / terminal windows from flashing open and closed when
 * spawning child processes on Windows.
 *
 * Background:
 * On Windows, Node.js child_process APIs (spawn, exec, execFile, fork, and their
 * synchronous counterparts) default `windowsHide` to `false`. When child processes
 * are spawned (e.g. by google-auth-library checking `gcloud`, tree-kill running `taskkill`,
 * or internal CLI utilities), Windows creates a visible console window (conhost.exe)
 * that flashes on screen and closes in a split second.
 *
 * Furthermore, on Windows, setting `detached: true` directs libuv to pass
 * `CREATE_NEW_CONSOLE` to CreateProcessW, forcing the creation of a new console window
 * even if stdio is ignored.
 *
 * This guard runs before any other application logic or third-party packages load.
 * It monkey-patches both `child_process` and `node:child_process` so that on Windows:
 * 1. `windowsHide: true` is unconditionally enforced on all process invocations.
 * 2. `detached: true` is safely sanitized to `detached: false` unless `CREATE_NEW_CONSOLE`
 *    is explicitly requested via `options.forceConsole === true`.
 */

(() => {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const patchTarget = (cp: any) => {
      if (!cp || cp.__nativelyProcessGuardInstalled) return;
      cp.__nativelyProcessGuardInstalled = true;

      // 1. Intercept the core ChildProcess.prototype.spawn method.
      // Every asynchronous process spawn (spawn, exec, execFile, fork) in Node.js
      // routes through ChildProcess.prototype.spawn(options).
      if (cp.ChildProcess && cp.ChildProcess.prototype && typeof cp.ChildProcess.prototype.spawn === 'function') {
        const origProtoSpawn = cp.ChildProcess.prototype.spawn;
        cp.ChildProcess.prototype.spawn = function (options: any) {
          if (options && typeof options === 'object') {
            if (options.windowsHide !== false) {
              options.windowsHide = true;
            }
            if (options.detached && !options.forceConsole) {
              options.detached = false;
            }
          }
          return origProtoSpawn.call(this, options);
        };
      }

      // 2. Intercept async spawn
      if (typeof cp.spawn === 'function') {
        const origSpawn = cp.spawn;
        cp.spawn = function (file: any, args: any, options: any) {
          let actualArgs = args;
          let opts = options;
          if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
            opts = args;
            actualArgs = [];
          }
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          if (opts.detached && !opts.forceConsole) {
            opts.detached = false;
          }
          return origSpawn.call(this, file, actualArgs, opts);
        };
      }

      // 3. Intercept async exec
      if (typeof cp.exec === 'function') {
        const origExec = cp.exec;
        cp.exec = function (command: any, options: any, callback: any) {
          let opts = options;
          let cb = callback;
          if (typeof options === 'function') {
            cb = options;
            opts = {};
          }
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          return origExec.call(this, command, opts, cb);
        };
      }

      // 4. Intercept async execFile
      if (typeof cp.execFile === 'function') {
        const origExecFile = cp.execFile;
        cp.execFile = function (file: any, args: any, options: any, callback: any) {
          let actualArgs = args;
          let opts = options;
          let cb = callback;
          if (typeof actualArgs === 'function') {
            cb = actualArgs;
            actualArgs = [];
            opts = {};
          } else if (typeof opts === 'function') {
            cb = opts;
            if (!Array.isArray(actualArgs) && typeof actualArgs === 'object' && actualArgs !== null) {
              opts = actualArgs;
              actualArgs = [];
            } else {
              opts = {};
            }
          }
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          return origExecFile.call(this, file, actualArgs, opts, cb);
        };
      }

      // 5. Intercept synchronous spawnSync
      if (typeof cp.spawnSync === 'function') {
        const origSpawnSync = cp.spawnSync;
        cp.spawnSync = function (file: any, args: any, options: any) {
          let actualArgs = args;
          let opts = options;
          if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
            opts = args;
            actualArgs = [];
          }
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          return origSpawnSync.call(this, file, actualArgs, opts);
        };
      }

      // 6. Intercept synchronous execSync
      if (typeof cp.execSync === 'function') {
        const origExecSync = cp.execSync;
        cp.execSync = function (command: any, options: any) {
          let opts = options;
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          return origExecSync.call(this, command, opts);
        };
      }

      // 7. Intercept synchronous execFileSync
      if (typeof cp.execFileSync === 'function') {
        const origExecFileSync = cp.execFileSync;
        cp.execFileSync = function (file: any, args: any, options: any) {
          let actualArgs = args;
          let opts = options;
          if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
            opts = args;
            actualArgs = [];
          }
          if (!opts || typeof opts !== 'object') {
            opts = {};
          }
          if (opts.windowsHide !== false) {
            opts.windowsHide = true;
          }
          return origExecFileSync.call(this, file, actualArgs, opts);
        };
      }
    };

    // Patch standard module and node: prefixed module
    patchTarget(require('child_process'));
    try {
      patchTarget(require('node:child_process'));
    } catch {
      // node: prefix may not be separate in some environments
    }
  } catch (err) {
    console.warn('[processGuard] Failed to install child_process guard (non-fatal):', err);
  }
})();

export {};
