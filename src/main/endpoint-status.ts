import { isIPv4 } from 'node:net';

const TRACKED_ENDPOINTS = 1024;
// Chromium connection failures. Certificate, proxy and DNS errors do not prove an endpoint outage.
const CONNECTION_FAILURES = new Set([-7, -100, -101, -102, -109, -118]);

export function loopbackEndpoint(rawUrl: string): string | null {
  try {
    const { protocol, hostname, port } = new URL(rawUrl);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    if (hostname !== '[::1]' && !(hostname.startsWith('127.') && isIPv4(hostname))) return null;
    return `${hostname}:${port || (protocol === 'https:' ? 443 : 80)}`;
  } catch {
    return null;
  }
}

export interface EndpointFailure {
  url: string;
  key: string;
  revision: number;
  generation: number;
}

interface Observation {
  present: boolean;
  recoveredAt: number;
}

export class EndpointStatus {
  private readonly observed = new Map<string, Observation>();
  private revision = 0;
  private generation = 0;

  observe(urls: Iterable<string> | null): void {
    if (!urls) return;
    const present = new Set<string>();
    for (const url of urls) {
      const key = loopbackEndpoint(url);
      if (key) present.add(key);
    }
    this.revision++;
    for (const [key, observation] of this.observed) {
      if (!present.has(key)) observation.present = false;
    }
    for (const key of present) {
      const previous = this.observed.get(key);
      const recoveredAt = previous && !previous.present ? this.revision : previous?.recoveredAt ?? 0;
      this.observed.delete(key);
      this.observed.set(key, { present: true, recoveredAt });
    }
    while (this.observed.size > TRACKED_ENDPOINTS) this.observed.delete(this.observed.keys().next().value!);
  }

  clear(): void {
    this.observed.clear();
    this.generation++;
  }

  status(url: string): 'missing' | null {
    const key = loopbackEndpoint(url);
    return key && this.observed.get(key)?.present === false ? 'missing' : null;
  }

  failure(url: string, code: number): EndpointFailure | null {
    if (!CONNECTION_FAILURES.has(code)) return null;
    const key = loopbackEndpoint(url);
    return key && this.observed.has(key) ? { url, key, revision: this.revision, generation: this.generation } : null;
  }

  retry(url: string, failure: EndpointFailure | null): string | null {
    if (!failure || failure.url !== url || failure.generation !== this.generation) return null;
    const observation = this.observed.get(failure.key);
    return observation?.present && observation.recoveredAt > failure.revision ? failure.url : null;
  }
}
