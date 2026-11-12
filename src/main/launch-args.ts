export function parseLaunchArgs(argv: readonly string[]): { urls: string[]; importBookmarks: boolean } {
  const args = argv.slice(1);
  const delimiter = args.indexOf('--');
  const options = delimiter === -1 ? args : args.slice(0, delimiter);
  return {
    urls: args.filter((arg) => /^https?:\/\//i.test(arg)),
    importBookmarks: options.includes('--import-bookmarks'),
  };
}
