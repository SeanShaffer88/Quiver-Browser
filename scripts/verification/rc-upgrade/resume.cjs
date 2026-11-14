const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { profileEnvironment } = require('./runtime.cjs');

const executable = path.resolve(process.argv[2]);
const evidencePath = path.resolve(process.argv[3]);
const scenario = process.argv[4] ?? 'disconnect';
const data = fs.realpathSync.native(path.resolve(process.argv[5]));
const { env, portable } = profileEnvironment(data);
assert.ok(['disconnect', 'paused-close'].includes(scenario), 'Unknown scenario');
const payload = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + (i >>> 8) * 7) & 255;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { scenario, platform: os.platform(), build: os.release(), executable, data, portable,
  fixtureSha256: sha(payload), requests: [], processes: [], checks: {} };
const stateFile = path.join(data, 'quiver-state.json');
const portFile = path.join(data, 'DevToolsActivePort');
let output;
const checkpoints = path.join(data, 'download-partials');
const sockets = new Set();
let browser;
let phase = 'initial';
let cut = false;
let cutBytes = 0;

const server = http.createServer(async (request, response) => {
  const route = request.url;
  if (route === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Quiver RC HTTP fixture</title><a id="start" href="/fixture.bin">Download fixture</a>');
    return;
  }
  if (route !== '/fixture.bin') { response.writeHead(404).end(); return; }
  const range = request.headers.range ?? '';
  const parsedRange = /^bytes=(\d+)-$/.exec(range);
  const start = range ? Number(parsedRange?.[1]) : 0;
  const entry = { phase, route, range, start, ifRange: request.headers['if-range'] ?? null };
  report.requests.push(entry);
  if (cut && phase === 'initial') {
    entry.aborted = true;
    request.socket.destroy();
    return;
  }
  if (!Number.isSafeInteger(start) || start >= payload.length) {
    entry.status = 416;
    response.writeHead(416, { 'Content-Range': 'bytes */' + payload.length }).end();
    return;
  }
  const headers = {
    'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': payload.length - start,
    'Content-Disposition': 'attachment; filename="' + fixtureName + '"',
    'ETag': '"quiver-rc-fixed"', 'Last-Modified': 'Wed, 11 Nov 2026 12:00:00 GMT', 'Cache-Control': 'no-store',
  };
  if (range) headers['Content-Range'] = 'bytes ' + start + '-' + (payload.length - 1) + '/' + payload.length;
  entry.status = range ? 206 : 200;
  response.writeHead(entry.status, headers);
  for (let offset = start; offset < payload.length; offset += 65536) {
    if (response.destroyed) return;
    response.write(payload.subarray(offset, offset + 65536));
    if (phase === 'initial') cutBytes += Math.min(65536, payload.length - offset);
    if (phase === 'initial' && cutBytes >= 1048576 && allowCut) {
      cut = true;
      entry.aborted = true;
      await delay(100);
      response.destroy();
      return;
    }
    await delay(phase === 'initial' ? 90 : 25);
  }
  response.end();
});
let allowCut = false;
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

async function until(label, probe, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) { last = error.message; }
    await delay(125);
  }
  throw new Error('Timed out waiting for ' + label + (last ? ': ' + last : ''));
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    }
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const requestId = ++id;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error('CDP timed out: ' + method));
          }, 3500);
          pending.set(requestId, {
            resolve: (value) => { clearTimeout(timeout); resolve(value); },
            reject: (error) => { clearTimeout(timeout); reject(error); },
          });
          socket.send(JSON.stringify({ id: requestId, method, params }));
        });
      },
      close() { socket.close(); },
    }), { once: true });
  });
}

async function withTarget(url, action) {
  const connection = await connect(url);
  try { return await action(connection); } finally { connection.close(); }
}

async function evaluate(url, expression) {
  return withTarget(url, async (connection) => {
    const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  });
}

async function launch(origin, label) {
  fs.rmSync(portFile, { force: true });
  const logPath = evidencePath.replace(/\.json$/i, '') + '-' + label + '-browser.log';
  const log = fs.openSync(logPath, 'w');
  browser = spawn(executable, [
    '--user-data-dir=' + data, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--disable-background-networking', '--disable-component-update', '--no-pings',
    '--', ...(origin ? [origin] : []),
  ], {
    cwd: data, windowsHide: true, stdio: ['ignore', log, log],
    env,
  });
  fs.closeSync(log);
  const processEvidence = { label, pid: browser.pid, logPath };
  report.processes.push(processEvidence);
  browser.on('exit', (code, signal) => Object.assign(processEvidence, { code, signal }));
  browser.on('error', (error) => { processEvidence.error = error.message; });
  const [port, browserPath] = await until('owned DevTools port file', () => {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    return /^\d{1,5}$/.test(lines[0]) && /^\/devtools\/browser\/[0-9a-f-]+$/.test(lines[1]) && lines;
  });
  await until('loopback-only listener owned by the test process', () => {
    const netstat = execFileSync(path.join(process.env.SystemRoot, 'System32', 'netstat.exe'), ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const listeners = netstat.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter((row) => row[1]?.endsWith(':' + port) && row[3] === 'LISTENING');
    return listeners.length === 1 && listeners[0][1] === '127.0.0.1:' + port && listeners[0][4] === String(browser.pid);
  });
  const base = 'http://127.0.0.1:' + port;
  const pages = async () => (await fetch(base + '/json/list', { signal: AbortSignal.timeout(1500) })).json();
  const page = (predicate) => until('expected browser page', async () => {
    const target = (await pages()).find(({ url }) => predicate(url));
    return /^[a-f0-9]+$/i.test(target?.id ?? '') && 'ws://127.0.0.1:' + port + '/devtools/page/' + target.id;
  });
  return { page, close: async () => {
    const child = browser;
    const exit = once(child, 'exit');
    await withTarget('ws://127.0.0.1:' + port + browserPath, (connection) => connection.send('Browser.close')).catch(() => {});
    processEvidence.closeMethod = 'Browser.close';
    processEvidence.closeRequested = true;
    const result = await Promise.race([exit, delay(15000, null, { ref: false })]);
    assert.ok(result, 'Browser did not close normally');
    assert.equal(result[0], 0, 'Browser did not exit cleanly');
    browser = undefined;
    fs.rmSync(portFile, { force: true });
  } };
}

const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const records = () => state().downloads ?? [];
let fixtureName;
const fixtureRecord = () => records().find((record) => record.filename === fixtureName);
function files(directory = output) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, bytes: entry.isFile() ? fs.statSync(path.join(directory, entry.name)).size : null }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
const snapshot = async (page) => ({
  record: fixtureRecord() ?? null,
  files: files(),
  checkpoints: files(checkpoints),
  ...(page ? { ui: await ui(page) } : {}),
});
const button = (page, label) => evaluate(page, `(() => { const button = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!button) return false; button.click(); return true; })()`);
const clickLink = (page, id) => until('fixture link ' + id, () => evaluate(page,
  `(() => { const link = document.getElementById(${JSON.stringify(id)}); if (!link) return false; link.click(); return true; })()`));
const ui = (page) => evaluate(page, '({ rows: [...document.querySelectorAll(".download")].map(x => ({ name: x.querySelector(".download-name")?.textContent, state: x.className, text: x.innerText, progress: x.querySelector("progress")?.value, buttons: [...x.querySelectorAll("button")].map(b => b.getAttribute("aria-label")) })), status: document.getElementById("status")?.textContent })');
const targetDownloads = (url) => url.startsWith('quiver://app/downloads.html');

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port + '/';
  const baseline = state();
  assert.equal(baseline.sessionOpen, false);
  assert.equal(baseline.settings.askWhereToSave, false);
  fixtureName = 'quiver-upgrade-' + scenario + '.bin';
  assert.equal(fixtureRecord(), undefined, 'This fixture scenario has already been run in the profile');
  const initial = await launch(origin, 'initial');
  await until('automatic-save fixture configuration persisted', () =>
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).settings.askWhereToSave === false);
  const fixture = await initial.page((url) => url === origin);
  await clickLink(fixture, 'start');
  const shell = await initial.page((url) => url === 'quiver://app/shell.html');
  await until('Downloads toolbar control', () => evaluate(shell, 'Boolean(document.querySelector(".downloads-chip"))'));
  await evaluate(shell, 'document.querySelector(".downloads-chip").click()');
  const downloads = await initial.page(targetDownloads);
  const record = await until('persisted output location', fixtureRecord);
  output = path.dirname(record.savePath);
  assert.equal(path.basename(record.savePath), fixtureName);
  if (portable) assert.equal(path.relative(path.join(data, 'Downloads'), output), '');
  else assert.equal(path.basename(output).toLowerCase(), 'downloads');
  const finalPath = path.join(output, fixtureName);
  const resumeLabel = 'Resume ' + fixtureName;
  const pauseLabel = 'Pause ' + fixtureName;
  report.checks.initialProgress = await until('visible nonzero download progress', async () =>
    (await ui(downloads)).rows.find((row) => row.name === fixtureName && row.progress > 0));
  report.checks.interruption = {};
  if (scenario !== 'paused-close') {
    allowCut = true;
    await until('fixture HTTP disconnect', () => cut);
    report.cutAfterBytes = cutBytes;
    await until('interrupted resumable download visible', async () =>
      (await ui(downloads)).rows.find((row) => row.state.endsWith(' interrupted') && row.buttons.includes(resumeLabel)));
  } else {
    await until('more bytes before pausing', async () =>
      (await ui(downloads)).rows.some((row) => row.name === fixtureName && row.progress >= 1048576));
    assert.equal(await button(downloads, pauseLabel), true);
    await until('paused download persisted', () => {
      const current = fixtureRecord();
      return current?.paused && current.received >= 1048576;
    });
  }
  report.checks.interruption.beforeClose = await snapshot(downloads);
  await initial.close();
  report.checks.interruption.afterClose = await snapshot();
  const saved = report.checks.interruption.afterClose.record;
  assert.ok(saved && saved.received > 0 && saved.received < payload.length, 'No partial transfer persisted');
  phase = 'restart';
  const restarted = await launch(null, 'restart');
  const reopened = await restarted.page(targetDownloads);
  const check = report.checks.restartResume = {
    expectedRange: 'bytes=' + saved.received + '-',
    restoredRow: await until('restored download row with Resume', async () =>
      (await ui(reopened)).rows.find((row) => row.buttons.includes(resumeLabel))).catch(() => null),
    beforeClick: await snapshot(reopened),
  };
  const first = () => report.requests.find((entry) => entry.phase === 'restart' && entry.route === '/fixture.bin');
  check.requestBeforeClick = first() ?? null;
  check.resumeButton = check.restoredRow ? await button(reopened, resumeLabel) : false;
  check.firstRequest = (check.resumeButton
    ? await until('first post-restart fixture request after one Resume click', first, 5500).catch(() => null)
    : first()) ?? null;
  check.afterClick = await snapshot(reopened);
  check.exactRange = check.firstRequest?.range === check.expectedRange && check.firstRequest?.status === 206;
  check.completedUi = check.exactRange ? await until('completed resumed fixture', async () =>
    (await ui(reopened)).rows.find((row) => row.name === fixtureName && row.state.endsWith(' completed')), 12000).catch(() => null) : null;
  check.completedState = check.completedUi ? await until('completed state persisted', () => {
    const record = fixtureRecord();
    return record?.state === 'completed' && record;
  }, 5000).catch(() => null) : null;
  check.sameRecord = check.completedState?.id === saved.id && records().length === (baseline.downloads?.length ?? 0) + 1;
  await restarted.close();
  const outputs = files();
  const ownFiles = outputs.filter(({ name }) => name.startsWith(fixtureName.replace(/\.bin$/, '')));
  report.checks.output = { files: ownFiles, checkpoints: files(checkpoints), sha256: fs.existsSync(finalPath) ? sha(fs.readFileSync(finalPath)) : null };
  report.checks.output.passed = ownFiles.length === 1 && ownFiles[0].name === fixtureName && ownFiles[0].bytes === payload.length
    && report.checks.output.sha256 === report.fixtureSha256 && report.checks.output.checkpoints.length === 0;
  const closed = state();
  assert.equal(closed.sessionOpen, false);
  for (const key of ['spaces', 'bookmarks', 'settings']) assert.deepEqual(closed[key], baseline[key]);
  for (const [space, tabs] of Object.entries(baseline.tabsBySpace)) {
    for (const tab of tabs) assert.ok(closed.tabsBySpace[space].some((entry) =>
      entry.url === tab.url && entry.customTitle === tab.customTitle && entry.pinned === tab.pinned && entry.folderId === tab.folderId));
  }
  report.checks.baselineProfilePreserved = true;
  check.passed = !check.requestBeforeClick && check.resumeButton && check.exactRange && !!check.completedUi && check.sameRecord;
  report.passed = check.passed && report.checks.output.passed;
  if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
  report.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
}).finally(() => {
  if (browser?.pid && browser.exitCode === null && !browser.signalCode) {
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(browser.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 6000,
      });
      report.cleanupExit = 0;
    } catch (error) {
      report.cleanupExit = error.status ?? null;
    }
  }
  for (const socket of sockets) socket.destroy();
  server.close();
  fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2));
  console.log('Download evidence: ' + evidencePath);
});
