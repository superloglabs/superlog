export const USER_CREATED_QUEUE = "user.created";
export const USER_CREATED_DELAY_SECONDS = 5 * 60;

export type UserCreatedEvent = {
  userId: string;
  email: string;
  name?: string | null;
  createdAt: string;
};

export type UserCreatedQueue = {
  createQueue(name: string, options?: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<unknown>;
};

export async function publishUserCreated(
  queue: UserCreatedQueue,
  user: { id: string; email: string; name?: string | null; createdAt: Date | string },
): Promise<void> {
  await queue.createQueue(USER_CREATED_QUEUE, { policy: "standard" });
  await queue.send(
    USER_CREATED_QUEUE,
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      createdAt: new Date(user.createdAt).toISOString(),
    } satisfies UserCreatedEvent,
    {
      // Better Auth user ids are UUIDs. Reusing that value as pg-boss' primary
      // key makes a retried signup hook idempotent at the queue boundary.
      id: user.id,
      startAfter: USER_CREATED_DELAY_SECONDS,
      retryLimit: 3,
      retryBackoff: true,
    },
  );
}
