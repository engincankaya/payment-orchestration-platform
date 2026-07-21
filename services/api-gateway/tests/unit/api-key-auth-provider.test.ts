import ApiKeyAuthProvider from '../../src/services/auth/api-key-auth-provider';

describe('ApiKeyAuthProvider', () => {
  it('fails fast when PUBLIC_API_KEY is missing', () => {
    expect(() => new ApiKeyAuthProvider({ env: {} })).toThrow('PUBLIC_API_KEY is required');
  });

  it('authenticates a matching API key', async () => {
    const provider = new ApiKeyAuthProvider({
      env: { PUBLIC_API_KEY: 'public-test-key' },
    });

    await expect(provider.authenticate('public-test-key')).resolves.toMatchObject({
      apiKeyId: 'local-public-api-key',
      scopes: ['payments:create', 'payments:read'],
    });
  });

  it('rejects missing, empty, or different API keys', async () => {
    const provider = new ApiKeyAuthProvider({
      env: { PUBLIC_API_KEY: 'public-test-key' },
    });

    await expect(provider.authenticate()).resolves.toBeNull();
    await expect(provider.authenticate('')).resolves.toBeNull();
    await expect(provider.authenticate('wrong-key')).resolves.toBeNull();
  });
});
