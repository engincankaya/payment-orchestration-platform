import MockPaymentProvider from '../../src/services/providers/mock-payment-provider';
import ProviderRegistryService from '../../src/services/providers/provider-registry-service';

const providerName = 'configured-mock-provider';

const makeRegistry = () => {
  const mockPaymentProvider = new MockPaymentProvider({
    env: { MOCK_PROVIDER_NAME: providerName },
  });

  return {
    mockPaymentProvider,
    registry: new ProviderRegistryService({ mockPaymentProvider }),
  };
};

describe('ProviderRegistryService.getProvider', () => {
  it('returns the registered adapter for its provider name', () => {
    const { mockPaymentProvider, registry } = makeRegistry();

    expect(registry.getProvider(providerName)).toBe(mockPaymentProvider);
  });

  it('fails closed for an unknown provider without falling back to the default provider', () => {
    const { registry } = makeRegistry();
    const getDefaultProvider = jest.spyOn(registry, 'getDefaultProvider');

    expect(() => registry.getProvider('unknown-provider')).toThrow(
      expect.objectContaining({
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        statusCode: 500,
        isOperational: false,
      }),
    );
    expect(getDefaultProvider).not.toHaveBeenCalled();
  });
});
