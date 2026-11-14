const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { command, evaluate, launch, processTreeKill, profileEnvironment, waitFor } = require('./runtime.cjs');

const prompt = '[data-focus-key=permission-once]';
const always = '[data-focus-key=permission-always]';
const badge = '.media-permission';
const retry = '[data-focus-key=retry-crashed-tab]';
const previewButton = '[data-focus-key=phone-preview]';
const exists = (page, selector) => evaluate(page, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const click = (page, selector) => evaluate(page, `document.querySelector(${JSON.stringify(selector)}).click()`);
const ready = (page) => evaluate(page, 'document.readyState === "complete" && Boolean(navigator.mediaDevices)');

async function requestMedia(page, kind, keepTrack = false) {
  await evaluate(page, `(() => {
    window.outcome = 'pending';
    navigator.mediaDevices.getUserMedia({ ${kind}: true }).then(
      (stream) => {
        window.outcome = stream.getTracks()[0]?.readyState;
        if (${keepTrack}) window.stream = stream;
        else stream.getTracks().forEach(track => track.stop());
      },
      (error) => { window.outcome = error.name; }
    );
    return true;
  })()`);
}

async function closeFixture(shell, url) {
  const shellInvoke = async (expression) => {
    const response = await command(shell, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  const tab = await waitFor('active media fixture in shell state', async () => {
    const state = await shellInvoke('window.quiver.invoke("state:get")');
    return state.tabs.find(entry => entry.id === state.activeTabId && entry.url === url && !entry.pinned);
  });
  assert.ok(Number.isInteger(tab.id));
  await shellInvoke(`window.quiver.invoke("tab:close", ${tab.id})`);
  await waitFor('fixture tab closed', async () => {
    const state = await shellInvoke('window.quiver.invoke("state:get")');
    return state.tabs.every(entry => entry.id !== tab.id);
  });
}

async function rendererRecovery(app, shell, page, url, label, result) {
  await requestMedia(page, 'video', true);
  await waitFor('media permission prompt', () => exists(shell, prompt));
  if (label === 'allowed') {
    await click(shell, prompt);
    await waitFor('live synthetic camera', () => evaluate(page, 'window.stream?.getVideoTracks()[0]?.readyState === "live"'));
    await waitFor('camera permission badge', () => exists(shell, badge));
  }
  const mediaState = async () => ({ prompt: await exists(shell, prompt), badge: await exists(shell, badge) });
  result.before = await mediaState();
  assert.deepEqual(result.before, { prompt: label === 'pending', badge: label === 'allowed' });
  await command(page, 'Page.crash').catch(() => {});
  await waitFor('browser recovery control', () => exists(shell, retry));
  result.afterCrash = await mediaState();
  assert.deepEqual(result.afterCrash, { prompt: false, badge: false });
  await click(shell, retry);
  const reopened = await app.page(url, false);
  await waitFor('recovered media page', () => ready(reopened));
  await requestMedia(reopened, 'video');
  await waitFor('fresh media prompt after Retry', () => exists(shell, prompt));
  result.retryPrompted = await evaluate(reopened, 'window.outcome === "pending"');
  assert.equal(result.retryPrompted, true);
}

async function phonePreview(app, shell, desktop, url, label, result) {
  await waitFor('Phone Preview button', () => exists(shell, previewButton));
  await click(shell, previewButton);
  const preview = await app.page(url, true);
  await waitFor('emulated Phone Preview ready', () => evaluate(preview,
    'document.readyState === "complete" && Boolean(navigator.mediaDevices) && navigator.maxTouchPoints > 0'));
  const queryCamera = (page) => command(page, 'Runtime.evaluate', {
    expression: 'navigator.permissions.query({name:"camera"}).then(p => p.state)', awaitPromise: true, returnByValue: true,
  }).then(value => value.result.value);
  result.previewQuery = await queryCamera(preview);
  result.desktopQuery = await queryCamera(desktop);
  assert.equal(result.previewQuery, 'denied');
  if (label === 'saved-allow') assert.equal(result.desktopQuery, 'granted');
  if (label === 'no-choice') {
    await evaluate(desktop, 'document.cookie="phone_session=shared; Max-Age=3600; Path=/; SameSite=Lax"');
  }
  const hasSessionCookie = (page) => evaluate(page, 'document.cookie.split("; ").includes("phone_session=shared")');
  result.sharedCookie = await hasSessionCookie(desktop) && await hasSessionCookie(preview);
  assert.equal(result.sharedCookie, true);
  const mediaOutcome = (page) => evaluate(page, 'window.outcome === "pending" ? false : window.outcome');
  result.previewMedia = {};
  for (const kind of ['video', 'audio']) {
    await requestMedia(preview, kind);
    result.previewMedia[kind] = await waitFor(`Phone Preview ${kind} denial`, () => mediaOutcome(preview), 5000);
    assert.equal(result.previewMedia[kind], 'NotAllowedError');
    assert.equal(await exists(shell, prompt), false);
  }
  await command(preview, 'Runtime.evaluate', {
    expression: `(() => {
      window.shareOutcome = 'pending';
      navigator.mediaDevices.getDisplayMedia({ video: true }).then(
        (stream) => { window.shareOutcome = 'granted'; stream.getTracks().forEach(track => track.stop()); },
        (error) => { window.shareOutcome = error.name; }
      ); return true;
    })()`,
    userGesture: true, returnByValue: true,
  });
  result.screenOutcome = await waitFor('Phone Preview screen sharing denial', () => evaluate(preview,
    'window.shareOutcome === "pending" ? false : window.shareOutcome'), 5000);
  assert.ok(['AbortError', 'NotAllowedError'].includes(result.screenOutcome));
  result.previewPrompt = await exists(shell, prompt);
  assert.equal(result.previewPrompt, false);
  await requestMedia(desktop, 'video');
  if (label === 'no-choice') {
    await waitFor('normal tab permission prompt', () => exists(shell, always));
    await click(shell, always);
  }
  result.desktopOutcome = await waitFor('normal tab synthetic camera grant', () => mediaOutcome(desktop));
  assert.equal(result.desktopOutcome, 'live');
  result.desktopPromptDismissed = await waitFor('normal desktop permission prompt dismissed', async () => !await exists(shell, prompt));
  if (label === 'saved-allow') {
    await evaluate(desktop, 'document.cookie="phone_session=; Max-Age=0; Path=/; SameSite=Lax"');
    result.fixtureCookieRemoved = await waitFor('shared Phone Preview fixture cookie removed', async () =>
      !await hasSessionCookie(desktop) && !await hasSessionCookie(preview));
  }
}

async function main() {
  const [scenario, ...inputs] = process.argv.slice(2);
  assert.equal(inputs.length, 3);
  const [executable, profile, evidence] = inputs.map(value => path.resolve(value));
  const data = fs.realpathSync.native(profile);
  const { portable } = profileEnvironment(data);
  const scenarios = {
    'renderer-recovery': { labels: ['pending', 'allowed'], run: rendererRecovery },
    'phone-preview': { labels: ['no-choice', 'saved-allow'], run: phonePreview },
  };
  const test = scenarios[scenario];
  assert.ok(test, 'Expected a renderer-recovery or phone-preview scenario');
  const statePath = path.join(data, 'quiver-state.json');
  const closedState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const report = { scenario, executable, data, portable, build: os.release(), cases: [], passed: false };
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Quiver upgraded media fixture</title>');
  });
  let app;
  try {
    assert.equal(closedState().sessionOpen, false);
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal(closedState().settings.sitePermissions?.[origin], undefined);
    for (const label of test.labels) {
      const result = { label };
      report.cases.push(result);
      const url = origin + '/' + label;
      app = await launch(executable, data, result, evidence + '.' + label, url);
      const shell = await app.page('quiver://app/shell.html');
      const page = await app.page(url, false);
      await waitFor('media fixture ready', () => ready(page));
      await test.run(app, shell, page, url, label, result);
      await closeFixture(shell, url);
      await app.close();
      app = undefined;
      assert.equal(closedState().sessionOpen, false);
      if (scenario === 'phone-preview') {
        result.savedAllow = closedState().settings.sitePermissions?.[origin];
        assert.equal(result.savedAllow, 'allow');
      }
    }
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    if (app) report.cleanupExit = processTreeKill(app.child);
    server.closeAllConnections();
    server.close();
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
