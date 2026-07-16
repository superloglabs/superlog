export interface ExpiredGcpAuthorizationTokenStore {
  clearExpiredTokens(now: Date): Promise<number>;
}

export async function cleanupExpiredGcpAuthorizationTokens(input: {
  store: ExpiredGcpAuthorizationTokenStore;
  now?: Date;
}): Promise<number> {
  return input.store.clearExpiredTokens(input.now ?? new Date());
}
