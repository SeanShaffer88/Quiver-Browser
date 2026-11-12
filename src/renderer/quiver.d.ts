interface QuiverApi {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
}
declare const quiver: QuiverApi;
