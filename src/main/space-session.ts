import { SHARED_PARTITION } from '../shared/constants';
import type { Space } from '../shared/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function arcImportId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function arcSpaceId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('arc-space-') && arcImportId(value.slice(10));
}

export function normalizeArcSpace(space: Space): Space {
  if (arcSpaceId(space.id) && arcImportId(space.arcImportId) && arcImportId(space.sessionGroupId)) return { ...space, isolated: true };
  const { arcImportId: _import, sessionGroupId: _group, ...other } = space;
  return arcSpaceId(space.id) ? { ...other, isolated: true } : other;
}

export function webSpacePartition(space?: Space): string {
  if (space && arcSpaceId(space.id) && arcImportId(space.arcImportId) && arcImportId(space.sessionGroupId)) {
    return `persist:quiver-arc-${space.sessionGroupId}`;
  }
  return space?.isolated ? `persist:quiver-space-${space.id}` : SHARED_PARTITION;
}
