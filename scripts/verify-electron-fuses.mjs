import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const executable = process.argv[2];
if (!executable || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/verify-electron-fuses.mjs <Quiver.exe>');
}

const wire = await getCurrentFuseWire(executable);
if (wire.version !== FuseVersion.V1) {
  throw new Error(`Unsupported Electron fuse wire version: ${wire.version}`);
}

const expected = [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
];

// getCurrentFuseWire returns the raw ASCII state bytes for version 1.
for (const [fuse, enabled] of expected) {
  const state = enabled ? '1' : '0';
  if (wire[fuse] !== state.charCodeAt(0)) {
    throw new Error(`Expected ${FuseV1Options[fuse]} to be ${enabled ? 'enabled' : 'disabled'}`);
  }
}
console.log(`Verified ${expected.length} Electron fuses in ${executable}`);
