import {
  AuthorizePaymentInput,
  AuthorizePaymentResult,
  CapturePaymentInput,
  CapturePaymentResult,
  PaymentProvider,
} from './payment-provider';

export default class MockPaymentProvider implements PaymentProvider {
  private providerName: string;

  constructor(deps: { env: NodeJS.ProcessEnv }) {
    this.providerName = deps.env.MOCK_PROVIDER_NAME ?? 'mock-provider';
  }

  public authorize = async (input: AuthorizePaymentInput): Promise<AuthorizePaymentResult> => {
    if (input.amountMinor === 9999) {
      return {
        success: false,
        provider: this.providerName,
        failureCode: 'MOCK_AUTHORIZATION_FAILED',
        failureMessage: 'Mock provider authorization failure',
      };
    }

    return {
      success: true,
      provider: this.providerName,
      providerPaymentId: `mock_${input.paymentId}`,
    };
  };

  public capture = async (input: CapturePaymentInput): Promise<CapturePaymentResult> => {
    if (input.amountMinor === 8888) {
      return {
        success: false,
        provider: this.providerName,
        failureCode: 'MOCK_CAPTURE_FAILED',
        failureMessage: 'Mock provider capture failure',
      };
    }

    return {
      success: true,
      provider: this.providerName,
    };
  };
}
