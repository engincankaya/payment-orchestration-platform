import MockPaymentProvider from './mock-payment-provider';
import { PaymentProvider } from './payment-provider';

export default class ProviderRegistryService {
  private mockPaymentProvider: MockPaymentProvider;

  constructor(deps: { mockPaymentProvider: MockPaymentProvider }) {
    this.mockPaymentProvider = deps.mockPaymentProvider;
  }

  public getDefaultProvider = (): PaymentProvider => {
    return this.mockPaymentProvider;
  };
}
