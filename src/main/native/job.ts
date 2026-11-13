/** Shared plumbing for Quiver's own downloaders (FTP, HLS, DASH, Metalink). */

export type Fetcher = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface JobProgress {
  received: number;
  /** 0 when the size is not known yet. */
  total: number;
  detail: string;
}

/** Pause and cancel for a running job. Work awaits `ready()` between steps; cancel aborts in-flight requests. */
export class JobControl {
  private readonly abort = new AbortController();
  private pausedWait: { promise: Promise<void>; release: () => void } | null = null;

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get paused(): boolean {
    return this.pausedWait !== null;
  }

  get cancelled(): boolean {
    return this.abort.signal.aborted;
  }

  pause(): void {
    if (this.pausedWait || this.cancelled) return;
    let release = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.pausedWait = { promise, release };
  }

  resume(): void {
    const wait = this.pausedWait;
    this.pausedWait = null;
    wait?.release();
  }

  cancel(): void {
    this.abort.abort(new Error('Cancelled'));
    this.resume();
  }

  /** Wait while paused; throw if cancelled. */
  async ready(): Promise<void> {
    while (this.pausedWait) await this.pausedWait.promise;
    if (this.cancelled) throw new Error('Cancelled');
  }
}

export interface JobContext {
  fetch: Fetcher;
  control: JobControl;
  progress(p: JobProgress): void;
}

/** Fetch a URL and fail with a readable message unless it succeeded. */
export async function fetchOk(ctx: JobContext, url: string, headers?: Record<string, string>): Promise<Response> {
  const response = await ctx.fetch(url, { headers, signal: ctx.control.signal });
  if (!response.ok && response.status !== 206) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  return response;
}

export async function fetchBytes(ctx: JobContext, url: string, headers?: Record<string, string>, limit = 512 * 1024 * 1024): Promise<Buffer> {
  const response = await fetchOk(ctx, url, headers);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error('A part of the download is too large.');
  return buffer;
}

export async function fetchText(ctx: JobContext, url: string): Promise<string> {
  return (await fetchBytes(ctx, url, undefined, 32 * 1024 * 1024)).toString('utf8');
}
