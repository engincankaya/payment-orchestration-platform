import MockPaymentProvider from '../../src/services/providers/mock-payment-provider';
import type {
  AuthorizePaymentResult,
  CapturePaymentResult,
} from '../../src/services/providers/payment-provider';

type Assert<T extends true> = T;
type AuthorizationSuccessRequiresProviderReference = Assert<
  { success: true; provider: string } extends AuthorizePaymentResult ? false : true
>;
type AuthorizationFailureRequiresCode = Assert<
  {
    success: false;
    provider: string;
    providerPaymentId?: string;
    failureMessage: string;
  } extends AuthorizePaymentResult
    ? false
    : true
>;
type AuthorizationFailureRequiresMessage = Assert<
  {
    success: false;
    provider: string;
    providerPaymentId?: string;
    failureCode: string;
  } extends AuthorizePaymentResult
    ? false
    : true
>;
type CaptureFailureRequiresCode = Assert<
  {
    success: false;
    provider: string;
    failureMessage: string;
  } extends CapturePaymentResult
    ? false
    : true
>;
type CaptureFailureRequiresMessage = Assert<
  {
    success: false;
    provider: string;
    failureCode: string;
  } extends CapturePaymentResult
    ? false
    : true
>;

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
