import type { Suggestion } from '../shared/types';
import { lastSeenLabel, type OtherDevice } from './continuity';
import { fuzzyScore } from './palette';

/** `devices` or `devices <words>`: other devices, their Spaces and their tabs. */
export function devicesQuery(text: string): string | undefined {
  const m = /^devices?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] ?? '').trim() : undefined;
}

/**
 * `send`, `send tab`, `send to <device>`, `send tab to <device>`, or `send <device>`. `explicit` is false for the
 * last form, which only counts when a device matches, so a search such as "send flowers" still searches.
 */
export function sendQuery(text: string): { query: string; explicit: boolean } | undefined {
  const m = /^send(\s+tab)?(\s+to)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const query = (m[3] ?? '').trim();
  return { query, explicit: !query || !!m[1] || !!m[2] };
}

/** Whether `send <words>` names one of the devices. */
export function sendMatches(query: string, targets: readonly OtherDevice[]): boolean {
  return targets.some((d) => fuzzyScore(query, d.name) >= 0);
}

export interface DeviceContext {
  /** A sync folder is chosen. */
  syncing: boolean;
  /** "Sync open tabs" is on. */
  openTabs: boolean;
  now: number;
  /** Addresses open on this device; their remote copies are not offered again when searching everything. */
  localUrls: ReadonlySet<string>;
}

function host(url: string): string {
  return URL.parse(url)?.host ?? '';
}

const setUp = (label: string): Suggestion => ({ kind: 'device', label, action: { type: 'internal', page: 'settings' } });

/** Suggestions for `devices …`: "Continue here" per Space, then the devices' tabs, most recently used first. */
export function deviceSuggestions(query: string, devices: readonly OtherDevice[], ctx: DeviceContext, limit = 30): Suggestion[] {
  if (!ctx.syncing) return [setUp('Choose a sync folder in Settings to see your other devices')];
  if (!ctx.openTabs) return [setUp('Turn on “Sync open tabs” in Settings → Sync to see other devices’ tabs')];
  const shown = devices.filter((d) => d.tabs?.spaces.length);
  if (!shown.length) {
    return [{ kind: 'device', label: devices.length ? 'Your other devices are not sharing open tabs' : 'No other devices yet', detail: 'Other devices appear here once they sync open tabs', action: { type: 'noop' } }];
  }
  const out: { score: number; order: number; suggestion: Suggestion }[] = [];
  let order = 0;
  for (const device of shown) {
    const seen = lastSeenLabel(device.lastSeen, ctx.now);
    for (const space of device.tabs!.spaces) {
      const active = space.id === device.tabs!.activeSpaceId;
      const s = query ? Math.max(fuzzyScore(query, `${device.name} ${space.name}`), fuzzyScore(query, `continue ${device.name}`)) : 0;
      if (s >= 0) {
        out.push({
          score: s + (active ? 5 : 0) + 100, order: order++,
          suggestion: {
            kind: 'device',
            label: `Continue here: ${space.name} from ${device.name}`,
            detail: `${space.tabs.length === 1 ? '1 tab' : `${space.tabs.length} tabs`}${active ? ' · active Space' : ''} · seen ${seen}`,
            action: { type: 'continue', deviceId: device.id, device: device.name, spaceId: space.id, space: space.name, count: space.tabs.length },
          },
        });
      }
      for (const tab of [...space.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
        const title = tab.title || host(tab.url) || tab.url;
        const t = query ? Math.max(fuzzyScore(query, title), fuzzyScore(query, host(tab.url)) - 5, fuzzyScore(query, device.name) - 10) : 0;
        if (t < 0) continue;
        out.push({
          score: t, order: order++,
          suggestion: { kind: 'device', label: title, detail: [host(tab.url), device.name, space.name].filter(Boolean).join(' · '), action: { type: 'remote-tab', deviceId: device.id, device: device.name, url: tab.url } },
        });
      }
    }
  }
  const list = out.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map((x) => x.suggestion);
  return list.length ? list : [{ kind: 'device', label: 'No matching tabs on other devices', action: { type: 'noop' } }];
}

/** Other devices' tabs matching what is typed, below this device's own matches. */
export function remoteTabMatches(query: string, devices: readonly OtherDevice[], ctx: DeviceContext, limit = 5): Suggestion[] {
  if (!ctx.syncing || !ctx.openTabs || query.length < 2) return [];
  const out: { score: number; suggestion: Suggestion }[] = [];
  const offered = new Set(ctx.localUrls);
  for (const device of devices) {
    for (const space of device.tabs?.spaces ?? []) {
      for (const tab of space.tabs) {
        if (offered.has(tab.url)) continue;
        const title = tab.title || host(tab.url) || tab.url;
        const s = Math.max(fuzzyScore(query, title), fuzzyScore(query, host(tab.url)) - 5);
        if (s < 0) continue;
        offered.add(tab.url);
        out.push({ score: s, suggestion: { kind: 'device', label: title, detail: [host(tab.url), `on ${device.name}`].filter(Boolean).join(' · '), action: { type: 'remote-tab', deviceId: device.id, device: device.name, url: tab.url } } });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.suggestion);
}

/** Suggestions for `send …`: one row per device that can receive tabs. `reason` explains why this tab cannot go. */
export function sendSuggestions(query: string, targets: readonly OtherDevice[], ctx: Pick<DeviceContext, 'syncing' | 'now'>, reason?: string): Suggestion[] {
  if (!ctx.syncing) return [setUp('Choose a sync folder in Settings to send tabs to your other devices')];
  if (reason) return [{ kind: 'send', label: reason, action: { type: 'noop' } }];
  if (!targets.length) return [{ kind: 'send', label: 'No other devices can receive tabs yet', detail: 'They need this version of Quiver syncing through the same folder', action: { type: 'noop' } }];
  const list = targets
    .map((d, order) => ({ d, order, score: query ? fuzzyScore(query, d.name) : 0 }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ d }): Suggestion => ({ kind: 'send', label: `Send this tab to ${d.name}`, detail: `seen ${lastSeenLabel(d.lastSeen, ctx.now)}`, action: { type: 'send-tab', deviceId: d.id, device: d.name } }));
  return list.length ? list : [{ kind: 'send', label: 'No device by that name', action: { type: 'noop' } }];
}
