import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCimProcesses, parseNetstatPids, projectDirFromCommandLine, projectName, ProjectNames, splitCommandLine } from '../main/devserver-projects';
import { parseProcNetTcp, scanDevServers, serverLabel } from '../main/devservers';

test('netstat -ano: listening ports map to their owning PID', () => {
  const out = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8840
  TCP    127.0.0.1:5173         127.0.0.1:50123        ESTABLISHED     8840
  TCP    [::1]:3000             [::]:0                 LISTENING       912
  TCP    [::]:3000              [::]:0                 LISTENING       913
  UDP    0.0.0.0:5353           *:*                                    2200
  TCP    127.0.0.1:80           0.0.0.0:0              LISTENING       0\r
`;
  assert.deepEqual([...parseNetstatPids(out)], [[135, 1012], [5173, 8840], [3000, 912]]);
});

test('command lines split like Windows does', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe"  C:\\app\\node_modules\\vite\\bin\\vite.js --port 5173'),
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\app\\node_modules\\vite\\bin\\vite.js', '--port', '5173']);
  assert.deepEqual(splitCommandLine('node "C:\\my app\\server.js" ""'), ['node', 'C:\\my app\\server.js', '']);
});

test('project folder from a dev server command line', () => {
  const files = new Set(['C:\\work\\shop\\package.json', '/home/me/blog/package.json', 'C:\\Program Files\\nodejs\\node_modules\\npm\\package.json']);
  const exists = (f: string) => files.has(f);
  const node = '"C:\\Program Files\\nodejs\\node.exe"';
  // vite / next / webpack run from node_modules: the folder above node_modules.
  assert.equal(projectDirFromCommandLine(`${node} C:\\work\\shop\\node_modules\\vite\\bin\\vite.js`, exists), 'C:\\work\\shop');
  assert.equal(projectDirFromCommandLine(`${node} "C:\\work\\shop\\node_modules\\.bin\\..\\next\\dist\\bin\\next" dev`, exists), 'C:\\work\\shop');
  // pnpm: the first node_modules is the project's own.
  assert.equal(projectDirFromCommandLine('node C:\\mono\\node_modules\\.pnpm\\vite@6\\node_modules\\vite\\bin\\vite.js', exists), 'C:\\mono');
  // A plain script: the nearest folder with a package.json.
  assert.equal(projectDirFromCommandLine(`${node} C:\\work\\shop\\src\\server\\index.js`, exists), 'C:\\work\\shop');
  assert.equal(projectDirFromCommandLine('/usr/bin/node /home/me/blog/scripts/serve.mjs', exists), '/home/me/blog');
  assert.equal(projectDirFromCommandLine(`${node} --config=C:\\work\\shop\\vite.config.ts`, exists), 'C:\\work\\shop');
  // npm's own script lives in the Node install folder: not a project.
  assert.equal(projectDirFromCommandLine(`${node} "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev`, exists), null);
  // Nothing path-like: fall back to the working directory (Linux), never the root.
  assert.equal(projectDirFromCommandLine('python -m http.server 8000', exists), null);
  assert.equal(projectDirFromCommandLine('python -m http.server 8000', exists, '', '/home/me/blog/dist'), '/home/me/blog');
  assert.equal(projectDirFromCommandLine('python -m http.server 8000', exists, '', '/home/me/site'), '/home/me/site');
  assert.equal(projectDirFromCommandLine('python -m http.server 8000', exists, '', '/'), null);
});

test('project names: package.json name without a scope, else the folder name', () => {
  const pkgs: Record<string, string> = {
    'C:\\work\\shop\\package.json': '{"name":"@acme/shop-web","version":"1.0.0"}',
    '/home/me/blog/package.json': '{"private":true}',
    '/home/me/bad/package.json': '{not json',
  };
  const read = (f: string) => pkgs[f] ?? null;
  assert.equal(projectName('C:\\work\\shop', read), 'shop-web');
  assert.equal(projectName('/home/me/blog', read), 'blog');
  assert.equal(projectName('/home/me/bad', read), 'bad');
  assert.equal(projectName('/home/me/none', read), 'none');
});

test('Win32_Process JSON: one row or several', () => {
  assert.deepEqual(parseCimProcesses('{"ProcessId":12,"ExecutablePath":"C:\\\\n.exe","CommandLine":"n x"}'),
    [{ pid: 12, executable: 'C:\\n.exe', commandLine: 'n x', cwd: '' }]);
  assert.deepEqual(parseCimProcesses('[{"ProcessId":1,"ExecutablePath":null,"CommandLine":null},{"nope":1}]'),
    [{ pid: 1, executable: '', commandLine: '', cwd: '' }]);
  assert.deepEqual(parseCimProcesses(''), []);
});

test('sidebar label combines project and page title', () => {
  const url = 'http://127.0.0.1:5173/';
  assert.equal(serverLabel({ project: 'shop', title: 'Shop — Home', url }), 'shop — Shop — Home');
  assert.equal(serverLabel({ project: 'shop', title: '127.0.0.1:5173', url }), 'shop', 'no page title: the project alone');
  assert.equal(serverLabel({ project: null, title: 'Shop', url }), 'Shop');
});

test('/proc/net/tcp: listening loopback and wildcard sockets with inodes', () => {
  const v4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5002 1 0 100 0 0 10 0
   2: 0501A8C0:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0 100 0 0 10 0
   3: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0 100 0 0 10 0`;
  assert.deepEqual(parseProcNetTcp(v4, false), [{ host: '127.0.0.1', port: 5173, inode: 5001 }, { host: '127.0.0.1', port: 3000, inode: 5002 }]);
  const v6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6001 1 0`;
  assert.deepEqual(parseProcNetTcp(v6, true), [{ host: '::1', port: 8080, inode: 6001 }]);
});

test('a running local server is named after its project folder (Linux /proc)', { skip: process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-devproj-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'quiver-fixture-app' }));
  fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>Fixture home</title>'); })
    .listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)); });`);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = Number(await new Promise<string>((resolve) => child.stdout!.once('data', (d) => resolve(String(d)))));
    const servers = (await scanDevServers())!;
    const mine = servers.find((s) => s.port === port);
    assert.ok(mine, `port ${port} found`);
    assert.equal(mine.project, 'quiver-fixture-app');
    assert.equal(mine.label, 'quiver-fixture-app — Fixture home');
    // Cached by PID: a second lookup doesn't change the answer.
    const names = new ProjectNames();
    assert.equal((await names.lookup([child.pid!])).get(child.pid!), 'quiver-fixture-app');
    assert.equal((await names.lookup([child.pid!])).get(child.pid!), 'quiver-fixture-app');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
