import { withoutSharerAccount } from './capsuleSharerAccount.mjs';
import { HttpError } from './security.mjs';

const actions = {
  mine: [], create: [], received: [],
  exportPreview: ['capsuleId','supersedes','scopes','card','excludeEntryIds','includePrivateEntries'],
  exportFile: ['capsuleId','password','supersedes','recipients','recipientNames','scopes','card','excludeEntryIds','includePrivateEntries'],
  exportHistory: ['capsuleId','cursor'], download: ['capsuleId','snapshotId'], revokeSnapshot: ['capsuleId','snapshotId','expectedRevision'],
  previewFile: ['archive','password'], importFile: ['archive','password','expectedDigest','confirmed','title'], pending: [], sent: ['capsuleId'], links: ['capsuleId'],
  deliver: ['capsuleId', 'recipients', 'scopes', 'card', 'excludeEntryIds', 'includePrivateEntries'],
  createLink: ['capsuleId', 'scopes', 'card', 'ttlDays', 'maxUses', 'excludeEntryIds', 'includePrivateEntries'],
  revokeLink: ['capsuleId', 'linkId'], previewLink: ['token'], importLink: ['token', 'expectedDigest', 'title'],
  previewDelivery: ['deliveryId'], importDelivery: ['deliveryId', 'expectedDigest', 'title'], decline: ['deliveryId'],
  takeDown: ['capsuleId', 'snapshotId', 'reason'],
};
export const SHARE_ACTIONS = Object.freeze(Object.keys(actions));

const hosted = new Set(['pending','sent','links','deliver','createLink','revokeLink','previewLink','importLink','previewDelivery','importDelivery','decline','takeDown']);
export const sharingActions = services => services ? SHARE_ACTIONS.filter(action => !hosted.has(action) || services.sharing) : [];

/** The authenticated owner's web sharing services; the caller cannot select an author or recipient identity. */
export async function shareForAgent({ service, sharing, transfers, links }, user, input) {
  const action = input?.action;
  if (typeof action !== 'string' || !Object.hasOwn(actions, action)
    || Object.keys(input).some(k => k !== 'action' && !actions[action].includes(k))) {
    throw new HttpError(400, 'capsule_payload_invalid', 'Invalid sharing action or fields.');
  }
  if (hosted.has(action) && !sharing) throw new HttpError(404, 'capsule_share_not_enabled', 'Hosted sharing is disabled.');
  const maxBytes = ['previewFile','importFile'].includes(action) ? 256 * 1024 : 16384;
  if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) throw new HttpError(413, 'payload_too_large', 'Sharing request is too large.');
  const { action: _action, capsuleId, deliveryId, linkId, snapshotId, token, ...options } = input;
  for (const id of actions[action].filter(field => field.endsWith('Id') || field === 'token')) {
    if (typeof input[id] !== 'string' || !input[id].trim() || input[id].length > 256) throw new HttpError(400, 'capsule_payload_invalid', 'A sharing identifier is missing or invalid.');
  }
  const owner = user.id;
  const context = { projectId: 'default', accountCreatedAt: user.accountCreatedAt };
  const run = async () => {
    switch (action) {
      case 'exportPreview': return transfers.exportPreview(owner, capsuleId, options);
      case 'exportFile': return transfers.export(owner, capsuleId, options, context);
      case 'exportHistory': return transfers.history(owner, capsuleId, options);
      case 'download': return transfers.download(owner, capsuleId, snapshotId);
      case 'revokeSnapshot': {
        const result = await transfers.revoke(owner, capsuleId, snapshotId, options.expectedRevision);
        await sharing?.afterRevoke(owner, snapshotId).catch(() => null);
        return result;
      }
      case 'previewFile': return transfers.preview(owner, options, context);
      case 'importFile': return transfers.import(owner, options, context);
      case 'mine': return service.mine(owner);
      case 'create': return service.ownCapsule(owner, { create: true });
      case 'received': return service.received(owner);
      case 'pending': return sharing.pending(owner);
      case 'sent': await transfers.assertOwnCapsule(owner, capsuleId); return sharing.sent(owner, { capsuleId });
      case 'links': await transfers.assertOwnCapsule(owner, capsuleId); return links.list(owner, { capsuleId });
      case 'deliver': return sharing.deliver(owner, capsuleId, options, context);
      case 'createLink': return sharing.createLink(owner, capsuleId, options, context);
      case 'revokeLink': await transfers.assertOwnCapsule(owner, capsuleId); return links.revoke(owner, linkId);
      case 'previewLink': return sharing.openLink(owner, token, context);
      case 'importLink': return sharing.importLink(owner, token, options, context);
      case 'previewDelivery': return sharing.open(owner, deliveryId, context);
      case 'importDelivery': return sharing.import(owner, deliveryId, options, context);
      case 'decline': return sharing.decline(owner, deliveryId);
      case 'takeDown':
        await transfers.snapshot(owner, capsuleId, snapshotId);
        return sharing.takeDown({ authorId: owner, snapshotId, by: 'author', reason: String(options.reason ?? '') });
    }
  };
  return withoutSharerAccount(await run());
}
