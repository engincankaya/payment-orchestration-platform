import MockPaymentProvider from './mock-payment-provider';
import { PaymentProvider } from './payment-provider';
import ApiError from '../../types/errors/api-error';

export default class ProviderRegistryService {
  private mockPaymentProvider: MockPaymentProvider;
  private providers: Map<string, PaymentProvider>;

  constructor(deps: { mockPaymentProvider: MockPaymentProvider }) {
    this.mockPaymentProvider = deps.mockPaymentProvider;
    this.providers = new Map([
      [this.mockPaymentProvider.getProviderName(), this.mockPaymentProvider],
    ]);
  }

  /** Returns the provider configured for new payment authorizations. */
  public getDefaultProvider = (): PaymentProvider => {
    return this.mockPaymentProvider;
  };

  /** Returns the named provider or fails when it is not configured. */
  public getProvider = (name: string): PaymentProvider => {
    const provider = this.providers.get(name);

    if (!provider) {
      throw new ApiError({
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        message: `Payment provider is not configured: ${name}`,
        statusCode: 500,
        isOperational: false,
      });
    }

    return provider;
  };
}
