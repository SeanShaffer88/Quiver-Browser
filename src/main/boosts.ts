import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './store';
import type { BoostFileInfo } from '../shared/types';

const NAME_RE = /^(all|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)\.(css|ts)$/;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./;

export function isValidBoostName(name: string): boolean {
  return name.length <= 200 && NAME_RE.test(name) && !WINDOWS_DEVICE_NAME.test(name);
}

export function boostKind(name: string): 'css' | 'ts' {
  return name.endsWith('.ts') ? 'ts' : 'css';
}

/** all.css / all.ts apply everywhere; host files match the exact hostname (www. ignored). */
export function boostMatchesHost(name: string, host: string): boolean {
  const base = name.replace(/\.(css|ts)$/, '');
  if (base === 'all') return true;
  const norm = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return norm(base) === norm(host);
}

type TsModule = typeof import('typescript');
let tsMod: TsModule | null = null;
const compileCache = new Map<string, string>();

export function transpileBoost(source: string): string {
  const cached = compileCache.get(source);
  if (cached !== undefined) return cached;
  if (!tsMod) tsMod = require('typescript') as TsModule;
  const out = tsMod.transpileModule(source, {
    compilerOptions: { target: tsMod.ScriptTarget.ES2022, module: tsMod.ModuleKind.None, removeComments: false },
    reportDiagnostics: false,
  }).outputText;
  if (compileCache.size > 50) compileCache.clear();
  compileCache.set(source, out);
  return out;
}

export function wrapScript(js: string, name: string): string {
  return `(function(){try{\n${js}\n}catch(e){console.error('[Quiver boost ${name}]',e)}})();`;
}

const CSS_TEMPLATE = (name: string) => `/* Quiver boost: ${name}\n   Applied live to ${name.startsWith('all.') ? 'every site' : 'matching sites'} on save. */\n`;
const TS_TEMPLATE = (name: string) => `// Quiver boost: ${name}\n// Runs on page load in the page context. Saving reloads matching tabs.\nconsole.log('[boost] ${name} loaded');\n`;

export class Boosts {
  readonly dir: string;
  private listeners = new Set<(name: string, kind: 'css' | 'ts', removed: boolean) => void>();
  private watcher: fs.FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private lastSig = new Map<string, string>();

  constructor() {
    this.dir = path.join(app.getPath('userData'), 'boosts');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  onChange(cb: (name: string, kind: 'css' | 'ts', removed: boolean) => void): void {
    this.listeners.add(cb);
  }

  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, (_evt, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (!isValidBoostName(name)) return;
        const prev = this.debounce.get(name);
        if (prev) clearTimeout(prev);
        this.debounce.set(
          name,
          setTimeout(() => {
            this.debounce.delete(name);
            this.emitIfChanged(name);
          }, 120),
        );
      });
    } catch (err) {
      console.warn('[quiver] boost watcher unavailable:', (err as Error).message);
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private signature(name: string): string {
    try {
      const st = fs.statSync(path.join(this.dir, name));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'gone';
    }
  }

  private emitIfChanged(name: string): void {
    const sig = this.signature(name);
    if (this.lastSig.get(name) === sig) return;
    this.lastSig.set(name, sig);
    for (const cb of this.listeners) cb(name, boostKind(name), sig === 'gone');
  }

  list(): BoostFileInfo[] {
    const out: BoostFileInfo[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!isValidBoostName(name)) continue;
      const st = fs.statSync(path.join(this.dir, name));
      if (!st.isFile()) continue;
      out.push({ name, kind: boostKind(name), size: st.size, mtimeMs: st.mtimeMs });
    }
    return out.sort((a, b) => (a.name === 'all.css' ? -1 : b.name === 'all.css' ? 1 : a.name.localeCompare(b.name)));
  }

  read(name: string): string {
    this.assertName(name);
    return fs.readFileSync(path.join(this.dir, name), 'utf8');
  }

  readIfExists(name: string): string | null {
    try {
      return this.read(name);
    } catch {
      return null;
    }
  }

  create(name: string): void {
    this.assertName(name);
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) {
      writeFileAtomic(file, boostKind(name) === 'ts' ? TS_TEMPLATE(name) : CSS_TEMPLATE(name));
      this.lastSig.set(name, this.signature(name));
    }
  }

  save(name: string, content: string): void {
    this.assertName(name);
    if (Buffer.byteLength(content, 'utf8') > 2_000_000) throw new Error('boost too large (2 MB max)');
    writeFileAtomic(path.join(this.dir, name), content);
    this.emitIfChanged(name);
  }

  remove(name: string): void {
    this.assertName(name);
    fs.rmSync(path.join(this.dir, name), { force: true });
    this.emitIfChanged(name);
  }

  matching(host: string): { css: string[]; ts: string[] } {
    const names = this.list().filter((b) => boostMatchesHost(b.name, host));
    return { css: names.filter((b) => b.kind === 'css').map((b) => b.name), ts: names.filter((b) => b.kind === 'ts').map((b) => b.name) };
  }

  private assertName(name: string): void {
    if (!isValidBoostName(name)) throw new Error(`invalid boost name "${name}" (use all.css or <hostname>.css|ts)`);
  }
}
