interface AuthSessionFixture {
  readonly user: {
    readonly createdAt: Date;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: string;
    readonly name: string;
    readonly twoFactorEnabled: boolean;
    readonly updatedAt: Date;
  };
}

// A Better Auth session payload for a completed sign-in: the authenticator is
// enrolled and this session proved a second factor.
export function authSessionFor<
  const User extends Pick<AuthSessionFixture["user"], "id"> &
    Partial<AuthSessionFixture["user"]>,
>(user: User) {
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    session: {
      createdAt: now,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      id: `session-${user.id}`,
      token: `token-${user.id}`,
      twoFactorVerified: true as const,
      updatedAt: now,
      userId: user.id,
    },
    user: {
      createdAt: now,
      email: `${user.id}@example.com`,
      emailVerified: true,
      name: user.id,
      twoFactorEnabled: true as const,
      updatedAt: now,
      ...user,
    },
  };
}

// A session opened with the password alone, before any second factor.
export function passwordOnlySessionFor<
  const User extends Pick<AuthSessionFixture["user"], "id"> &
    Partial<AuthSessionFixture["user"]>,
>(user: User) {
  const complete = authSessionFor(user);
  return {
    ...complete,
    session: { ...complete.session, twoFactorVerified: false },
  };
}
