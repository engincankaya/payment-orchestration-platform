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

  // Provider selection belongs here; PayTR/Iyzico/Stripe adapters should not leak into payment flows.
  public getDefaultProvider = (): PaymentProvider => {
    return this.mockPaymentProvider;
  };

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
