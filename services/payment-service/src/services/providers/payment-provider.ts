export interface AuthorizePaymentInput {
  paymentId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

export interface AuthorizePaymentResult {
  success: boolean;
  provider: string;
  providerPaymentId?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface CapturePaymentInput {
  paymentId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
}

export interface CapturePaymentResult {
  success: boolean;
  provider: string;
  failureCode?: string;
  failureMessage?: string;
}

// External gateways are adapted to this contract before they are used by payment orchestration.
export interface PaymentAuthorizer {
  /** Authorizes a payment with the provider. */
  authorize(input: AuthorizePaymentInput): Promise<AuthorizePaymentResult>;
}

export interface PaymentCapturer {
  /** Captures a previously authorized payment with the provider. */
  capture(input: CapturePaymentInput): Promise<CapturePaymentResult>;
}

export type PaymentProvider = PaymentAuthorizer & PaymentCapturer;
