// Task Manager 2 - Electron shell.
// Runs the same local server the browser version uses, in its own process, and
// points a native window at it. The server is killed with the window.

import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SERVER = path.join(ROOT, 'server', 'index.mjs');

let mainWindow = null;
let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(SERVER, [], {
      cwd: ROOT,
      // Inside Electron, process.execPath is electron.exe: without this flag
      // the forked "node" child would try to open a second app window.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TM2_PORT: process.env.TM2_PORT || '4719' },
      silent: true,
    });

    const timer = setTimeout(() => reject(new Error('The local server did not start in time.')), 20000);

    serverProcess.stdout?.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
    serverProcess.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

    serverProcess.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer);
        resolve(message.url);
      }
    });
    serverProcess.on('exit', (code) => {
      clearTimeout(timer);
      if (code && !mainWindow) reject(new Error(`The local server exited with code ${code}.`));
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#080b10',
    show: false,
    autoHideMenuBar: true,
    title: 'Task Manager 2',
    icon: path.join(ROOT, 'public', 'favicon.svg'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    const url = await startServer();
    await mainWindow.loadURL(url);
  } catch (error) {
    await mainWindow.loadURL(`data:text/html,${encodeURIComponent(`<body style="background:#080b10;color:#f87171;font-family:Segoe UI,sans-serif;padding:40px"><h2>Task Manager 2 could not start</h2><p>${String(error.message)}</p></body>`)}`);
  }
}

ipcMain.handle('tm2:elevate', async () => {
  try {
    const exe = process.execPath;
    const args = app.isPackaged ? [] : [ROOT];
    spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath "${exe}" -ArgumentList '${args.map((a) => `"${a}"`).join(' ')}' -Verb RunAs`,
    ], { windowsHide: true, detached: true, stdio: 'ignore' });
    setTimeout(() => app.quit(), 1200);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
}

app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});
app.on('before-quit', shutdown);
process.on('exit', shutdown);
