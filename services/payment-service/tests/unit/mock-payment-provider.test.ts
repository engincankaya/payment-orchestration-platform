import MockPaymentProvider from '../../src/services/providers/mock-payment-provider';

const makeProvider = (providerName = 'configured-mock-provider') =>
  new MockPaymentProvider({
    env: { MOCK_PROVIDER_NAME: providerName },
  });

describe('MockPaymentProvider', () => {
  it('returns a deterministic authorization failure for amountMinor 9999', async () => {
    const provider = makeProvider();

    await expect(
      provider.authorize({
        paymentId: 'payment-1',
        merchantId: 'merchant-1',
        amountMinor: 9999,
        currency: 'TRY',
      }),
    ).resolves.toMatchObject({
      success: false,
      provider: 'configured-mock-provider',
      failureCode: 'MOCK_AUTHORIZATION_FAILED',
    });
  });

  it('authorizes other amounts and returns a stable provider payment reference', async () => {
    const provider = makeProvider();

    await expect(
      provider.authorize({
        paymentId: 'payment-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).resolves.toEqual({
      success: true,
      provider: 'configured-mock-provider',
      providerPaymentId: 'mock_payment-1',
    });
  });

  it('returns a deterministic capture failure for amountMinor 8888', async () => {
    const provider = makeProvider();

    await expect(
      provider.capture({
        paymentId: 'payment-1',
        providerPaymentId: 'provider-payment-1',
        amountMinor: 8888,
        currency: 'TRY',
      }),
    ).resolves.toMatchObject({
      success: false,
      provider: 'configured-mock-provider',
      failureCode: 'MOCK_CAPTURE_FAILED',
    });
  });

  it('captures other amounts successfully with the provider name from env', async () => {
    const provider = makeProvider('merchant-configured-provider');

    await expect(
      provider.capture({
        paymentId: 'payment-1',
        providerPaymentId: 'provider-payment-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).resolves.toEqual({
      success: true,
      provider: 'merchant-configured-provider',
    });
  });
});
