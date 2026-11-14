const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(description, probe, timeout = 15000) {
  const until = Date.now() + timeout;
  let last;
  do {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  } while (Date.now() < until);
  throw new Error('Timed out waiting for ' + description + (last ? ': ' + last.message : ''));
}

async function command(endpoint, method, params = {}) {
  const socket = new WebSocket(endpoint);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 3000);
      socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) reject(new Error(method + ': ' + message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

async function evaluate(endpoint, expression) {
  const response = await command(endpoint, 'Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

function profileEnvironment(data) {
  const env = { ...process.env };
  const portable = env.QUIVER_UPGRADE_PORTABLE === '1';
  if (portable) {
    assert.equal(path.basename(data).toLowerCase(), 'data', 'Portable profile must be the package Data directory');
    delete env.BREAKPAD_DUMP_LOCATION;
    env.PORTABLE_EXECUTABLE_DIR = path.dirname(data);
  } else {
    assert.equal(path.basename(data).toLowerCase(), 'quiver', 'Setup profile must be named Quiver');
    assert.ok(env.APPDATA, 'Setup profile requires the installer account APPDATA');
    assert.equal(path.relative(path.resolve(env.APPDATA, 'Quiver'), data), '', 'Setup profile must match APPDATA\\Quiver');
    delete env.PORTABLE_EXECUTABLE_DIR;
  }
  return { env, portable };
}

function processTreeKill(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return null;
  try {
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 6000,
    });
    return 0;
  } catch (error) {
    return error.status ?? null;
  }
}

async function launch(executable, data, report, evidencePath) {
  const { env } = profileEnvironment(data);
  const portFile = path.join(data, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const log = fs.openSync(evidencePath + '.browser.log', 'w');
  const child = spawn(executable, [
    '--user-data-dir=' + data, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--disable-background-networking', '--disable-component-update', '--no-pings', '--',
  ], {
    cwd: path.dirname(executable), env, stdio: ['ignore', log, log], windowsHide: true,
  });
  fs.closeSync(log);
  report.browser = { pid: child.pid };
  child.on('exit', (code, signal) => Object.assign(report.browser, { code, signal }));
  child.on('error', (error) => { report.browser.spawnError = error.message; });
  try {
    const [port, browserPath] = await waitFor('owned browser debugger', () => {
      assert.equal(child.exitCode, null);
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      return /^\d{1,5}$/.test(lines[0]) && /^\/devtools\/browser\/[0-9a-f-]+$/.test(lines[1]) && lines;
    });
    await waitFor('loopback debugger listener owned by Quiver', () => {
      const result = execFileSync(path.join(process.env.SystemRoot, 'System32', 'netstat.exe'), ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
      const rows = result.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
        .filter((row) => row[1]?.endsWith(':' + port) && row[3] === 'LISTENING');
      return rows.length === 1 && rows[0][1] === '127.0.0.1:' + port && rows[0][4] === String(child.pid);
    });
    const loopback = '127.0.0.1:' + port;
    return {
      child,
      page: (url) => waitFor(url + ' target', async () => {
        const response = await fetch('http://' + loopback + '/json/list', { signal: AbortSignal.timeout(1200) });
        const page = (await response.json()).find((target) => target.url === url);
        return /^[a-f0-9]+$/i.test(page?.id ?? '') && 'ws://' + loopback + '/devtools/page/' + page.id;
      }),
      async close() {
        const exit = once(child, 'exit');
        await command('ws://' + loopback + browserPath, 'Browser.close').catch(() => {});
        const result = await Promise.race([exit, delay(10000, null, { ref: false })]);
        assert.ok(result, 'Quiver did not close cleanly');
        assert.equal(result[0], 0, 'Quiver exited with an error');
        fs.rmSync(portFile, { force: true });
      },
    };
  } catch (error) {
    report.browser.cleanupExit = processTreeKill(child);
    throw error;
  }
}

const marker = 'rc1-seeded';
const sessionCookie = 'quiverUpgrade=' + marker;
const storageKey = 'quiver-upgrade-storage';
const fixtureBookmark = { title: 'Quiver release upgrade bookmark', url: 'https://upgrade.example.invalid/' };
const fixtureSettings = { askWhereToSave: false, devServerScan: false, archiveAfterHours: 0, rememberHistory: false };
const primary = 'space-upgrade';
const secondary = 'space-main';

function seed(url) {
  return {
    version: 1,
    spaces: [
      { id: secondary, name: 'Main', color: '#5b8cff', isolated: false },
      {
        id: primary, name: 'Release upgrade fixture', color: '#5b8cff', isolated: true,
        folders: [{ id: 'upgrade-pin', name: 'Upgrade pins', parentId: null, collapsed: false }],
      },
    ],
    activeSpaceId: primary,
    activeIndexBySpace: { [secondary]: 0, [primary]: 0 },
    tabsBySpace: {
      [secondary]: [{ url: url + '?other=1', customTitle: 'Other fixture tab' }],
      [primary]: [{ url, customTitle: 'Upgrade fixture pin', pinned: true, folderId: 'upgrade-pin' }],
    },
    bookmarks: [fixtureBookmark],
    settings: fixtureSettings,
    sessionOpen: false,
    bounds: { width: 1040, height: 780, maximized: false },
  };
}

function stateShape(state) {
  const spaces = state.spaces.map(({ id, name, isolated, folders = [] }) => ({ id, name, isolated, folders }));
  const tabs = Object.fromEntries(Object.entries(state.tabsBySpace).map(([key, value]) => [key, value.map((tab) => {
    const { url, customTitle, pinned, folderId } = tab;
    return { url, customTitle, pinned: pinned ?? false, folderId: folderId ?? null };
  })]));
  const settings = Object.fromEntries(Object.keys(fixtureSettings).map((key) => [key, state.settings[key]]));
  return { spaces, tabs, settings, bookmarks: state.bookmarks, activeSpaceId: state.activeSpaceId };
}

async function verifyProfile(phase, executable, data, evidencePath, baselinePath) {
  assert.ok(['baseline', 'reopen'].includes(phase), 'Expected baseline or reopen');
  fs.mkdirSync(data, { recursive: true });
  data = fs.realpathSync.native(data);
  const { portable } = profileEnvironment(data);
  const report = { phase, executable, data, portable, platform: os.release(), fixtureSeeded: phase === 'baseline', passed: false };
  const baseline = phase === 'reopen' ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  if (baseline) {
    assert.equal(baseline.passed, true);
    assert.equal(baseline.portable, portable);
    assert.equal(baseline.data, data);
    assert.ok(Number.isInteger(baseline.port) && baseline.port > 1024 && baseline.port <= 65535);
  }

  const requestLog = [];
  const server = http.createServer((request, response) => {
    const route = request.url;
    if (!['/state', '/state?other=1'].includes(route)) return response.writeHead(404).end();
    requestLog.push({ route, cookie: request.headers.cookie ?? '' });
    response.setHeader('Cache-Control', 'no-store');
    if (phase === 'baseline' && route === '/state') {
      response.setHeader('Set-Cookie', sessionCookie + '; Max-Age=3600; Path=/; SameSite=Lax');
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Quiver upgrade fixture</title><p>Loopback upgrade fixture</p>');
  });

  let app;
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(baseline?.port ?? 0, '127.0.0.1', resolve));
    report.port = server.address().port;
    const url = 'http://127.0.0.1:' + report.port + '/state';
    const file = path.join(data, 'quiver-state.json');
    const expected = stateShape(seed(url));
    if (phase === 'baseline') fs.writeFileSync(file, JSON.stringify(seed(url)), { flag: 'wx' });
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stateShape(read()), expected);
    report.exeSha256 = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    app = await launch(executable, data, report, evidencePath);
    const page = await app.page(url);
    const shell = await app.page('quiver://app/shell.html');
    await waitFor('restored pinned tab and folder in Quiver', () => evaluate(shell,
      '["Upgrade fixture pin", "Upgrade pins"].every(text => document.body.innerText.includes(text))'));
    await waitFor('fixture DOM ready', () => evaluate(page, 'document.readyState === "complete"'));
    if (phase === 'baseline') {
      await evaluate(page, `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(marker)})`);
    }
    report.runtime = await evaluate(page, `({ cookie: document.cookie, storage: localStorage.getItem(${JSON.stringify(storageKey)}) })`);
    assert.equal(report.runtime.cookie, sessionCookie);
    assert.equal(report.runtime.storage, marker);
    const firstRequest = requestLog.find((entry) => entry.route === '/state');
    assert.equal(firstRequest?.cookie, phase === 'baseline' ? '' : sessionCookie);
    await app.close();
    assert.equal(read().sessionOpen, false);
    report.state = stateShape(read());
    assert.deepEqual(report.state, expected);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    if (app) {
      const cleanupExit = processTreeKill(app.child);
      if (cleanupExit !== null) report.browser.cleanupExit = cleanupExit;
    }
    report.requests = requestLog;
    server.closeAllConnections();
    server.close();
    fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  }
}

if (require.main === module) {
  const [phase, executable, data, evidencePath, baseline] = process.argv.slice(2);
  verifyProfile(phase, path.resolve(executable), path.resolve(data), path.resolve(evidencePath), baseline).catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
module.exports = { profileEnvironment };
