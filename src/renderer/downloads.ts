import type { DownloadInfo } from '../shared/types';

const list = document.getElementById('list')!;
const status = document.getElementById('status')!;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function remaining(d: DownloadInfo): string {
  if (!d.speed || !d.total || d.paused) return '';
  const seconds = Math.ceil((d.total - d.received) / d.speed);
  if (seconds < 60) return `${seconds} s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

function describe(d: DownloadInfo): string {
  const host = URL.parse(d.url)?.host ?? '';
  switch (d.state) {
    case 'progressing': {
      const of = d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received);
      return [d.paused ? 'Paused' : '', of, d.paused ? '' : d.speed ? `${size(d.speed)}/s` : '', remaining(d), host].filter(Boolean).join(' · ');
    }
    case 'completed': return [d.missing ? 'Deleted' : size(d.total || d.received), host].filter(Boolean).join(' · ');
    case 'cancelled': return ['Cancelled', host].join(' · ');
    default: return ['Failed', d.canResume ? 'can resume' : '', host].filter(Boolean).join(' · ');
  }
}

async function act(d: DownloadInfo, action: string): Promise<void> {
  let result = (await quiver.invoke('downloads:act', d.id, action)) as string;
  if (result === 'confirm') {
    if (!confirm(`${d.filename} can run programs on this computer. Open it only if you trust ${URL.parse(d.url)?.host ?? 'its source'}.\n\nOpen it now?`)) return;
    result = (await quiver.invoke('downloads:act', d.id, action, true)) as string;
  }
  status.textContent = result;
  status.className = 'status' + (result ? ' err' : '');
}

function button(label: string, d: DownloadInfo, action: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? ' primary' : '');
  b.textContent = label;
  b.setAttribute('aria-label', `${label} ${d.filename}`);
  b.addEventListener('click', () => void act(d, action));
  return b;
}

function render(items: DownloadInfo[]): void {
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'note';
    empty.textContent = 'No downloads yet.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...items.map((d) => {
    const li = document.createElement('li');
    li.className = `download ${d.state}`;
    const name = document.createElement('div');
    name.className = 'download-name';
    name.textContent = d.filename;
    name.title = d.savePath;
    const detail = document.createElement('div');
    detail.className = 'note';
    detail.textContent = describe(d);
    const body = document.createElement('div');
    body.className = 'download-body';
    body.append(name, detail);
    if (d.state === 'progressing') {
      const bar = document.createElement('progress');
      bar.max = d.total || 1;
      if (d.total) bar.value = d.received;
      else bar.removeAttribute('value');
      bar.setAttribute('aria-label', `${d.filename} progress`);
      body.append(bar);
    }
    const actions = document.createElement('div');
    actions.className = 'download-actions';
    if (d.state === 'progressing') {
      actions.append(d.paused ? button('Resume', d, 'resume', true) : button('Pause', d, 'pause'), button('Cancel', d, 'cancel'));
    } else if (d.state === 'completed' && !d.missing) {
      actions.append(button(d.risky ? 'Open…' : 'Open', d, 'open', true), button('Show in folder', d, 'show'));
    } else if (d.state === 'interrupted' && d.canResume) {
      actions.append(button('Resume', d, 'resume', true), button('Retry', d, 'retry'));
    } else {
      actions.append(button('Retry', d, 'retry'));
    }
    if (d.state !== 'progressing') actions.append(button('Remove', d, 'remove'));
    li.append(body, actions);
    return li;
  }));
}

async function refresh(): Promise<void> {
  render((await quiver.invoke('downloads:list')) as DownloadInfo[]);
}

document.getElementById('clear')!.addEventListener('click', async () => {
  await quiver.invoke('downloads:clear');
  await refresh();
});
quiver.on('downloads:changed', () => void refresh());
window.addEventListener('focus', () => void refresh());
void refresh();
