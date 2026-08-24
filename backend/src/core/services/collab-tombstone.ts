/**
 * Close collab sockets after a **committed** hide/delete (#1444).
 *
 * Do not call this on a Confluence delete intent that may still roll
 * `deleted_at` back — 4404 is permanent.
 */
import { tombstoneCollabRoom } from './collab-room-service.js';

export async function tombstoneCollabRoomAfterCommit(pageId: number): Promise<void> {
  await tombstoneCollabRoom(pageId, 4404, 'committed_delete');
}
