import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Names a local dev server after the project it runs from: port → owning PID → that process's command line (and,
 * on Linux, its working directory) → the project folder → its package.json "name", else the folder name.
 * Everything here is best effort; a server whose project can't be found keeps its page title.
 */

/** Port → owning PID, from `netstat -ano` (the last column of each LISTENING TCP row). */
export function parseNetstatPids(out: string): Map<number, number> {
  const pids = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    // PID 0 and 4 are the idle and System processes: kernel listeners (http.sys) have no project.
    if (pid > 4 && !pids.has(port)) pids.set(port, pid);
  }
  return pids;
}

/** Split a Windows-style command line into arguments; double quotes group, and are removed. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; started = true; } else if (!quoted && /\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else { current += ch; started = true; }
  }
  if (started) args.push(current);
  return args;
}

const isWindowsPath = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');
const api = (p: string) => (isWindowsPath(p) ? path.win32 : path.posix);

/** The folder above the first node_modules in a path, e.g. C:\app\node_modules\.bin\vite → C:\app. */
function aboveNodeModules(p: string): string | null {
  const parts = p.split(/[\\/]/);
  const i = parts.findIndex((part) => part.toLowerCase() === 'node_modules');
  return i > 0 ? parts.slice(0, i).join(isWindowsPath(p) ? '\\' : '/') || '/' : null;
}

/** The nearest folder at or above `start` that holds a package.json (at most eight levels up). */
function nearestPackage(start: string, exists: (file: string) => boolean): string | null {
  const p = api(start);
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (exists(p.join(dir, 'package.json'))) return dir;
    const up = p.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The project folder a dev server runs from, judged from its command line: a script inside node_modules (vite,
 * next, webpack…) belongs to the folder above node_modules; another path argument belongs to the nearest folder
 * with a package.json. The executable itself, and anything inside its install folder (npm-cli.js under
 * nodejs\), are ignored. `cwd`, when known, is the last resort.
 */
export function projectDirFromCommandLine(commandLine: string, exists: (file: string) => boolean, executable = '', cwd = ''): string | null {
  const args = splitCommandLine(commandLine);
  const exe = executable || args[0] || '';
  const exeDir = exe ? api(exe).dirname(exe).toLowerCase() : '';
  for (const raw of args.slice(1)) {
    // --config=C:\app\vite.config.ts and similar: the path is after the "=".
    const arg = raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
    if (!isWindowsPath(arg) && !arg.startsWith('/')) continue;
    if (exeDir && api(arg).normalize(arg).toLowerCase().startsWith(exeDir + api(arg).sep)) continue;
    const above = aboveNodeModules(arg);
    if (above) return above;
    const found = nearestPackage(api(arg).dirname(arg), exists);
    if (found) return found;
  }
  if (!cwd) return null;
  // A server started from the filesystem root isn't in a project folder.
  return nearestPackage(cwd, exists) ?? (api(cwd).parse(cwd).root === cwd ? null : cwd);
}

/** The name to show for a project folder: package.json "name" (without an npm scope), else the folder name. */
export function projectName(dir: string, read: (file: string) => string | null): string {
  const p = api(dir);
  try {
    const name = (JSON.parse(read(p.join(dir, 'package.json')) ?? 'null') as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim()) return name.trim().replace(/^@[^/]+\//, '').slice(0, 60);
  } catch {
    // No or unreadable package.json: the folder name will do.
  }
  return p.basename(dir) || dir;
}

export interface ProcessInfo { pid: number; executable: string; commandLine: string; cwd: string }

/** Parse ConvertTo-Json output of Win32_Process rows (one row comes back as an object, several as an array). */
export function parseCimProcesses(json: string): ProcessInfo[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.flatMap((row: { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown }) =>
    typeof row?.ProcessId === 'number'
      ? [{ pid: row.ProcessId, executable: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : '', commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '', cwd: '' }]
      : []);
}

function windowsProcesses(pids: number[]): Promise<ProcessInfo[]> {
  const windows = process.env.SystemRoot;
  if (!windows || !pids.length) return Promise.resolve([]);
  // Only integers go into the script, so nothing from a page or process can reach the PowerShell parser.
  const filter = pids.filter((p) => Number.isSafeInteger(p) && p > 0).map((p) => `ProcessId=${p}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile(path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 5000, maxBuffer: 2_000_000,
    }, (err, stdout) => resolve(err ? [] : parseCimProcesses(stdout)));
  });
}

function linuxProcesses(pids: number[]): ProcessInfo[] {
  return pids.flatMap((pid) => {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      // Re-quote so splitCommandLine gets the same arguments back.
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      // A server started from the home folder isn't in a project; naming it after the user would mislead.
      return [{ pid, executable: args[0] ?? '', commandLine: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), cwd: cwd === os.homedir() ? '' : cwd }];
    } catch {
      return [];
    }
  });
}

const exists = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const read = (file: string) => { try { return fs.readFileSync(file, 'utf8').slice(0, 1_000_000); } catch { return null; } };

/** Project names by PID, looked up once per PID: a process's command line doesn't change while it runs. */
export class ProjectNames {
  private cache = new Map<number, string | null>();

  async lookup(pids: Iterable<number>): Promise<Map<number, string | null>> {
    const wanted = [...new Set(pids)];
    // Forget processes that are gone, so a reused PID is looked up again.
    for (const pid of this.cache.keys()) if (!wanted.includes(pid)) this.cache.delete(pid);
    const missing = wanted.filter((pid) => !this.cache.has(pid));
    if (missing.length) {
      const infos = process.platform === 'win32' ? await windowsProcesses(missing) : process.platform === 'linux' ? linuxProcesses(missing) : [];
      for (const pid of missing) {
        const info = infos.find((i) => i.pid === pid);
        const dir = info ? projectDirFromCommandLine(info.commandLine, exists, info.executable, info.cwd) : null;
        this.cache.set(pid, dir ? projectName(dir, read) : null);
      }
    }
    return new Map(wanted.map((pid) => [pid, this.cache.get(pid) ?? null]));
  }
}
