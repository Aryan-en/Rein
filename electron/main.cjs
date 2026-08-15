const { app, BrowserWindow, utilityProcess } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let mainWindow;
let serverProcess;
let serverHost = '0.0.0.0';
let serverPort = 3000;

// Load server config (port/host overrides)
try {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'src', 'server-config.json'),
    path.join(__dirname, '..', 'src', 'server-config.json'),
    path.join(process.cwd(), 'src', 'server-config.json'),
  ].filter(Boolean);

  for (const configPath of candidates) {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.host) serverHost = config.host;
      if (config.frontendPort) serverPort = config.frontendPort;
      break;
    }
  }
} catch (e) {}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Poll until server responds (or timeout)
function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() > deadline) {
        return reject(new Error(`Server did not respond within ${timeoutMs}ms`));
      }
      http.get(url, () => resolve()).on('error', () => setTimeout(check, 500));
    };
    check();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      '.output',
      'server',
      'index.mjs'
    );

    if (!fs.existsSync(serverPath)) {
      const msg = `Server not found: ${serverPath}`;
      log(`[ERROR] ${msg}`);
      return reject(new Error(msg));
    }

    log(`Starting server: ${serverPath}`);

    serverProcess = utilityProcess.fork(serverPath, [], {
      stdio: 'pipe',
      env: {
        ...process.env,
        HOST: serverHost,
        PORT: serverPort.toString(),
        REIN_DATA_DIR: app.getPath('userData'),
      },
    });

    let serverLog = '';
    const append = (chunk) => {
      serverLog += chunk;
      process.stdout.write(chunk);
      try { fs.appendFileSync(logPath, chunk); } catch (_) {}
    };

    if (serverProcess.stdout) serverProcess.stdout.on('data', d => append(d.toString()));
    if (serverProcess.stderr) serverProcess.stderr.on('data', d => append(d.toString()));

    serverProcess.on('exit', (code) => {
      log(`Server exited with code ${code}`);
      try {
        fs.writeFileSync(
          path.join(path.dirname(process.execPath), 'server-crash.log'),
          `Exit code: ${code}\n\n${serverLog}`
        );
      } catch (_) {}
    });

    waitForServer(`http://localhost:${serverPort}`, 30000).then(resolve).catch(reject);
  });
}

function createWindow() {
  if (mainWindow) return;

  const iconPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    '.output',
    'public',
    'app_icon',
    'Icon512.png'
  );

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    process.stdout.write(`[LOAD FAILED] ${code} ${desc}\n`);
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    process.stdout.write(`[FATAL] Server failed to start: ${err.message}\n`);
    dialog.showErrorBox('Rein failed to start', err.message);
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});