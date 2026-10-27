/** Existing domain fixtures edit a freshly read account. Conflict tests call
 * core.execute directly so stale and missing revisions are never repaired. */
export async function updateAccount(core, request, context) {
  const { user } = await core.execute({ action: 'admin.getUser', userId: request.userId }, context);
  return core.execute({ ...request, expectedRevision: user?.revision ?? 0 }, context);
}
