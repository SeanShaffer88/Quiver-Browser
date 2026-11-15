import type { Bookmark, ProfileKind, Space, SpaceBehavior } from '../shared/types';
import { ARCHIVE_OPTIONS } from './archive';
import { normalizeSitePermissions, type SiteDecision } from './site-permissions';
import { arcSpaceId, webSpacePartition } from './space-session';

/**
 * A profile is one storage partition and everything Quiver keeps for it: history, bookmarks and camera/microphone
 * decisions. Shared Spaces all use the shared profile. A Space with "Separate profile" has its own, and the Spaces of
 * one imported Arc profile share theirs. Private Spaces have no saved profile: they write nothing and read the
 * shared history and bookmarks.
 *
 * A profile id is the partition name without "persist:quiver-": "shared", "space-<id>" or "arc-<uuid>". Data from
 * before profiles existed has no profile, so it stays in the shared profile.
 */
export const SHARED_PROFILE = 'shared';
const PERSIST_PREFIX = 'persist:quiver-';
export const PROFILE_ID = /^[\w-]{1,80}$/;

export function profileOfPartition(partition: unknown): string | null {
  if (typeof partition !== 'string' || !partition.startsWith(PERSIST_PREFIX)) return null;
  const id = partition.slice(PERSIST_PREFIX.length);
  return id !== 'internal' && PROFILE_ID.test(id) ? id : null;
}

/** The profile a Space writes to; null for a private Space. */
export function spaceProfile(space: Space | undefined): string | null {
  if (space?.private) return null;
  return profileOfPartition(webSpacePartition(space)) ?? SHARED_PROFILE;
}

export function profileKind(space: Space | undefined): ProfileKind {
  if (space?.private) return 'private';
  return spaceProfile(space) === SHARED_PROFILE ? 'shared' : 'separate';
}

/** The profile whose history and bookmarks a Space shows. Private Spaces read the shared profile but never add to it. */
export function readingProfile(space: Space | undefined): string {
  return spaceProfile(space) ?? SHARED_PROFILE;
}

/** Separate profiles in use on this device. */
export function separateProfiles(spaces: readonly Space[]): Set<string> {
  const out = new Set<string>();
  for (const space of spaces) {
    const profile = spaceProfile(space);
    if (profile && profile !== SHARED_PROFILE) out.add(profile);
  }
  return out;
}

/** Separate profiles that stay on this device (imported Arc profiles are never synced). */
export function localOnlyProfiles(spaces: readonly Space[]): Set<string> {
  return new Set(spaces.filter((space) => !space.private && arcSpaceId(space.id)).map(spaceProfile).filter((p): p is string => !!p && p !== SHARED_PROFILE));
}

export function spacesInProfile(spaces: readonly Space[], profile: string): Space[] {
  return spaces.filter((space) => spaceProfile(space) === profile);
}

export function profileLabel(spaces: readonly Space[], profile: string): string {
  if (profile === SHARED_PROFILE) return 'Shared profile';
  const names = spacesInProfile(spaces, profile).map(({ name }) => name);
  return names.length ? `${names.join(', ')} profile` : 'Removed profile';
}

// ───────── bookmarks ─────────

/** The bookmarks a profile shows. The shared library is every bookmark without a profile. */
export function bookmarksForProfile(list: readonly Bookmark[], profile: string): Bookmark[] {
  return profile === SHARED_PROFILE ? list.filter((b) => !b.profile) : list.filter((b) => b.profile === profile);
}

/** Bookmarks of profiles this device doesn't have (synced from elsewhere, or spaces sync is off). Kept, not shown. */
export function bookmarksElsewhere(list: readonly Bookmark[], spaces: readonly Space[]): number {
  const known = separateProfiles(spaces);
  return list.filter((b) => b.profile && !known.has(b.profile)).length;
}

/** A deleted Space's bookmarks move to the shared library, except ones it already has. */
export function rehomeBookmarks(list: readonly Bookmark[], profile: string): Bookmark[] {
  const shared = new Set(list.filter((b) => !b.profile).map((b) => b.url));
  const out: Bookmark[] = [];
  for (const b of list) {
    if (b.profile !== profile) out.push(b);
    else if (!shared.has(b.url)) {
      shared.add(b.url);
      out.push({ title: b.title, url: b.url });
    }
  }
  return out;
}

/** The bookmarks published to sync: those of local-only profiles stay on this device. */
export function syncableBookmarks(list: readonly Bookmark[], localOnly: ReadonlySet<string>): Bookmark[] {
  return list.filter((b) => !b.profile || !localOnly.has(b.profile));
}

/** Bookmarks from sync replace the synced ones; bookmarks of local-only profiles are kept. */
export function withLocalOnlyBookmarks(remote: readonly Bookmark[], local: readonly Bookmark[], localOnly: ReadonlySet<string>): Bookmark[] {
  return [...remote.filter((b) => !b.profile || !localOnly.has(b.profile)), ...local.filter((b) => b.profile && localOnly.has(b.profile))];
}

// ───────── per-Space settings ─────────

const CONTROL = /[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁠-⁤⁦-⁩\s]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** One emoji (a single grapheme, ZWJ sequences and flags included), or undefined. */
export function normalizeSpaceIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const icon = value.trim();
  if (!icon || icon.length > 32 || CONTROL.test(icon.replace(/‍/g, '')) || !PICTOGRAPH.test(icon)) return undefined;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(icon)];
  return graphemes.length === 1 ? icon : undefined;
}

export function normalizeSpaceColor(value: unknown, fallback = '#5b8cff'): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

/**
 * Validate stored or submitted Space behavior. Spell check is set per storage session, so it is kept only for a
 * Space with a separate profile. Returns undefined when everything follows Settings.
 */
export function normalizeSpaceBehavior(raw: unknown, kind: ProfileKind): SpaceBehavior | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: SpaceBehavior = {};
  if (ARCHIVE_OPTIONS.includes(r.archiveAfterHours as (typeof ARCHIVE_OPTIONS)[number])) out.archiveAfterHours = r.archiveAfterHours as number;
  if (r.newTabPosition === 'top' || r.newTabPosition === 'bottom') out.newTabPosition = r.newTabPosition;
  if (r.peekLinks === 'pinned' || r.peekLinks === 'all' || r.peekLinks === 'off') out.peekLinks = r.peekLinks;
  if (kind === 'separate' && typeof r.spellcheck === 'boolean') out.spellcheck = r.spellcheck;
  return Object.keys(out).length ? out : undefined;
}

/** Apply a Settings → Spaces change: null removes an override, undefined leaves it alone. */
export function patchSpaceBehavior(current: SpaceBehavior | undefined, patch: unknown, kind: ProfileKind): SpaceBehavior | undefined {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!['archiveAfterHours', 'newTabPosition', 'peekLinks', 'spellcheck'].includes(key)) continue;
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return normalizeSpaceBehavior(next, kind);
}

/** Normalize the saved form of a Space's appearance and behavior (persisted state and sync both go through here). */
export function normalizeSpaceProfileFields(space: Space): Space {
  const { icon: _icon, behavior: _behavior, ...rest } = space;
  const icon = normalizeSpaceIcon(space.icon);
  const behavior = normalizeSpaceBehavior(space.behavior, profileKind(space));
  return { ...rest, color: normalizeSpaceColor(space.color), ...(icon ? { icon } : {}), ...(behavior ? { behavior } : {}) };
}

export function archiveHoursFor(space: Space | undefined, fallback: number): number {
  return space?.behavior?.archiveAfterHours ?? fallback;
}

/** Which links open in Peek for a Space: its own choice, else the Settings → Tabs switch for pinned tabs. */
export function peekModeFor(space: Space | undefined, peekPinnedLinks: boolean): 'pinned' | 'all' | 'off' {
  return space?.behavior?.peekLinks ?? (peekPinnedLinks ? 'pinned' : 'off');
}

// ───────── camera / microphone decisions ─────────

/** Saved decisions of separate profiles; the shared profile keeps its decisions in settings.sitePermissions. */
export function normalizeProfilePermissions(raw: unknown, known: ReadonlySet<string>): Record<string, Record<string, SiteDecision>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, SiteDecision>> = {};
  for (const [profile, decisions] of Object.entries(raw as Record<string, unknown>)) {
    if (profile === SHARED_PROFILE || !known.has(profile)) continue;
    const clean = normalizeSitePermissions(decisions);
    if (Object.keys(clean).length) out[profile] = clean;
  }
  return out;
}
