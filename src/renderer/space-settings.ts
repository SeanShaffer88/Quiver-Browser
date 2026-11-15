import type { ProfileContext, SpaceBehavior, SpaceSettingsView } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function kindLabel(space: SpaceSettingsView): string {
  if (space.kind === 'shared') return 'Profile: Shared';
  return space.sharesWith.length ? `Profile: Separate, shared with ${space.sharesWith.join(', ')}` : 'Profile: Separate';
}

/** Settings → Spaces and profiles: which profile this page shows, and each Space's icon, color and behavior. */
export async function setupSpaceSettings(profile: ProfileContext): Promise<void> {
  const pick = $<HTMLSelectElement>('space-pick');
  const icon = $<HTMLInputElement>('space-icon');
  const color = $<HTMLInputElement>('space-color');
  const archive = $<HTMLSelectElement>('space-archive');
  const newTab = $<HTMLSelectElement>('space-newtab');
  const peek = $<HTMLSelectElement>('space-peek');
  const spell = $<HTMLSelectElement>('space-spell');
  const status = $('space-status');

  $('profile-name').textContent = profile.kind === 'private' ? 'private Space' : profile.label;
  $('profile-detail').textContent = profile.kind === 'private'
    ? 'A private Space saves nothing: it shows the shared history and bookmarks but adds nothing to them.'
    : profile.kind === 'separate'
      ? `History, bookmarks and camera and microphone choices below belong to ${profile.spaces.join(', ')} only.`
      : 'History, bookmarks and camera and microphone choices below are shared by every Space without a separate profile.';

  let spaces = (await quiver.invoke('spaces:list')) as SpaceSettingsView[];
  const wanted = new URLSearchParams(location.search).get('space');
  const current = () => spaces.find((sp) => sp.id === pick.value);

  const fill = () => {
    const space = current();
    $('space-settings').hidden = !space;
    if (!space) return;
    $('space-pick-profile').textContent = kindLabel(space);
    if (document.activeElement !== icon) icon.value = space.icon;
    $<HTMLButtonElement>('space-icon-clear').disabled = !space.icon;
    color.value = space.color;
    archive.value = space.behavior.archiveAfterHours === undefined ? '' : String(space.behavior.archiveAfterHours);
    newTab.value = space.behavior.newTabPosition === 'top' ? 'top' : '';
    peek.value = space.behavior.peekLinks ?? '';
    spell.value = space.behavior.spellcheck === undefined ? '' : space.behavior.spellcheck ? 'on' : 'off';
    // Spell check is a setting of the storage session, which shared Spaces have in common.
    spell.disabled = space.kind !== 'separate';
    $('space-spell-note').textContent = space.kind === 'separate'
      ? (space.sharesWith.length ? 'Applies to every Space in this profile.' : 'Applies to this Space’s profile.')
      : 'Only a Space with a separate profile can choose its own spell check.';
  };

  const render = () => {
    const selected = pick.value || wanted || profile.spaceId;
    pick.replaceChildren(...spaces.map((sp) => {
      const option = document.createElement('option');
      option.value = sp.id;
      option.textContent = (sp.icon ? `${sp.icon} ` : '') + sp.name + (sp.kind === 'separate' ? ' (separate profile)' : '');
      return option;
    }));
    pick.value = spaces.some((sp) => sp.id === selected) ? selected : spaces[0]?.id ?? '';
    fill();
  };

  const update = async (patch: { icon?: string | null; color?: string; behavior?: Record<string, unknown> }, message = 'Saved') => {
    const space = current();
    if (!space) return;
    try {
      const next = (await quiver.invoke('spaces:update', space.id, patch)) as SpaceSettingsView | null;
      if (!next) throw new Error('This Space is no longer available.');
      spaces = spaces.map((sp) => (sp.id === next.id ? next : sp));
      render();
      status.textContent = message;
      status.className = 'status';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not save.';
      status.className = 'status err';
    }
  };
  const behavior = (key: keyof SpaceBehavior, value: unknown) => void update({ behavior: { [key]: value } });

  pick.addEventListener('change', () => {
    status.textContent = '';
    fill();
  });
  icon.addEventListener('change', () => {
    const value = icon.value.trim();
    if (!value) {
      void update({ icon: null }, 'Icon removed');
      return;
    }
    void update({ icon: value }).then(() => {
      if (current()?.icon !== value) {
        status.textContent = 'Use a single emoji for the icon.';
        status.className = 'status err';
        icon.value = current()?.icon ?? '';
      }
    });
  });
  $('space-icon-clear').addEventListener('click', () => {
    icon.value = '';
    void update({ icon: null }, 'Icon removed');
  });
  color.addEventListener('change', () => void update({ color: color.value }));
  archive.addEventListener('change', () => behavior('archiveAfterHours', archive.value === '' ? null : Number(archive.value)));
  newTab.addEventListener('change', () => behavior('newTabPosition', newTab.value === 'top' ? 'top' : null));
  peek.addEventListener('change', () => behavior('peekLinks', peek.value || null));
  spell.addEventListener('change', () => behavior('spellcheck', spell.value === '' ? null : spell.value === 'on'));

  render();
  if (wanted) {
    $('spaces-heading').scrollIntoView({ block: 'start' });
    pick.focus();
  }
}
