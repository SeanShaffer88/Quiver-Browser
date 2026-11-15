import type { LittleQuiverState } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $('title');
const host = $('host');
const status = $('status');
const progress = $('progress');
const open = $<HTMLButtonElement>('open');
let statusTimer: number | undefined;

function render(state: LittleQuiverState): void {
  title.textContent = state.title;
  title.title = state.url;
  host.textContent = state.host && state.host !== state.title ? state.host : '';
  progress.hidden = !state.loading;
  const where = state.space ? ` in the ${state.space} Space` : '';
  open.title = `Move this page into Quiver as a tab${where} (Ctrl+O)`;
  open.setAttribute('aria-label', `Open in Quiver${where} (Ctrl+O)`);
}

function say(text: string): void {
  clearTimeout(statusTimer);
  status.textContent = text;
  statusTimer = window.setTimeout(() => { status.textContent = ''; }, 2000);
}

quiver.on('little:state', (state: LittleQuiverState) => render(state));
void quiver.invoke('little:get').then((state: LittleQuiverState) => render(state));
$('copy').addEventListener('click', () => {
  void quiver.invoke('little:copy').then((url: string) => say(/^https?:/i.test(url) ? 'Link copied' : 'Nothing to copy yet'));
});
open.addEventListener('click', () => void quiver.invoke('little:open'));
$('close').addEventListener('click', () => void quiver.invoke('little:close'));
