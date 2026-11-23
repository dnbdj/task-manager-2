// Task Manager 2 - Electron shell.
//
// Runs the same local server the browser version uses, in its own process, and
// points a native window at it. The server is killed with the window.
//
// Everything that can fail at startup is written to .desktop.log as well as
// stdout: a packaged GUI app has no visible console, and "the window is black"
// is not a useful bug report.

import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import { fork, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SERVER = path.join(ROOT, 'server', 'index.mjs');
const LOG_FILE = path.join(ROOT, '.desktop.log');

let mainWindow = null;
let serverProcess = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try { process.stdout.write(`${line}\n`); } catch {}
  try { appendFileSync(LOG_FILE, `${line}\n`, 'utf8'); } catch {}
}

function shutdown() {
  if (serverProcess && !serverProcess.killed) {
    log('shutting down: ending the local server process');
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    log(`starting local server: ${SERVER}`);
    serverProcess = fork(SERVER, [], {
      cwd: ROOT,
      // Inside Electron, process.execPath is electron.exe: without this flag
      // the forked "node" child would try to open a second app window.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TM2_PORT: process.env.TM2_PORT || '4719' },
      silent: true,
    });

    let settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        log(`server failed: ${error.message}`);
        reject(error);
      } else {
        log(`server ready at ${url}`);
        resolve(url);
      }
    };

    const timer = setTimeout(() => finish(new Error('The local server did not start in time.')), 25000);

    serverProcess.stdout?.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) log(`[server] ${text}`);
    });
    serverProcess.stderr?.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) log(`[server:err] ${text}`);
    });

    serverProcess.on('message', (message) => {
      if (message?.type === 'ready') finish(null, message.url);
    });
    serverProcess.on('error', (error) => finish(new Error(`Could not spawn the local server: ${error.message}`)));
    serverProcess.on('exit', (code, signal) => {
      log(`local server exited (code=${code} signal=${signal})`);
      if (!settled) finish(new Error(`The local server exited before it was ready (code ${code}).`));
      else serverProcess = null;
      if (!app.isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        log('server died while the window was open');
        mainWindow.webContents.send?.('tm2:server-gone');
      }
    });
  });
}

function attachDiagnostics(window) {
  const contents = window.webContents;

  contents.on('did-finish-load', () => {
    log(`renderer finished loading: ${contents.getURL()}`);
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    log(`renderer FAILED to load ${url}: ${description} (${code})`);
  });
  contents.on('render-process-gone', (_event, details) => {
    log(`renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  contents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload error in ${preloadPath}: ${error?.message || error}`);
  });
  window.on('unresponsive', () => log('window became unresponsive'));
  window.on('responsive', () => log('window responsive again'));

  // Electron changed this event's signature between majors: newer versions pass
  // a single details object, older ones pass positional arguments.
  contents.on('console-message', (...args) => {
    const first = args[0];
    if (first && typeof first === 'object' && typeof first.message === 'string') {
      log(`renderer console [${first.level}] ${first.message} (${first.sourceId || '?'}:${first.lineNumber ?? '?'})`);
      return;
    }
    const [, level, message, line, sourceId] = args;
    log(`renderer console [${level}] ${message} (${sourceId || '?'}:${line ?? '?'})`);
  });
}

async function createWindow() {
  log(`creating window (electron ${process.versions.electron}, chromium ${process.versions.chrome})`);

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#080b10',
    show: false,
    autoHideMenuBar: true,
    title: 'Task Manager 2',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachDiagnostics(mainWindow);

  mainWindow.once('ready-to-show', () => {
    log('window ready-to-show');
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    log('window closed');
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    const url = await startServer();
    log(`loading ${url}`);
    await mainWindow.loadURL(url);
    log('loadURL resolved');
  } catch (error) {
    log(`startup failed: ${error.message}`);
    // Show the failure inside the window instead of a blank frame, but keep the
    // window on screen so the message is actually readable.
    const message = String(error.message || error).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
       <body style="background:#080b10;color:#f87171;font-family:Segoe UI,sans-serif;padding:40px;line-height:1.6">
         <h2 style="margin:0 0 8px">Task Manager 2 could not start</h2>
         <p style="color:#fca5a5">${message}</p>
         <p style="color:#8496a9;font-size:13px">Details were written to .desktop.log next to the app.</p>
       </body>`,
    )}`);
    mainWindow.show();
  }
}

ipcMain.handle('tm2:elevate', async () => {
  try {
    const exe = process.execPath;
    const args = app.isPackaged ? [] : [ROOT];
    log('elevation requested, relaunching with UAC');
    spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath "${exe}" -ArgumentList '${args.map((a) => `"${a}"`).join(' ')}' -Verb RunAs`,
    ], { windowsHide: true, detached: true, stdio: 'ignore' });
    setTimeout(() => app.quit(), 1200);
    return { ok: true };
  } catch (error) {
    log(`elevation failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(() => {
  log(`app ready; userData=${app.getPath('userData')}`);
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  log('all windows closed, quitting');
  app.isQuitting = true;
  shutdown();
  app.quit();
});
app.on('before-quit', () => {
  app.isQuitting = true;
  shutdown();
});
process.on('exit', shutdown);
