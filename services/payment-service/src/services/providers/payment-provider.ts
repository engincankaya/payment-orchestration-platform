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

export interface PaymentAuthorizer {
  authorize(input: AuthorizePaymentInput): Promise<AuthorizePaymentResult>;
}

export interface PaymentCapturer {
  capture(input: CapturePaymentInput): Promise<CapturePaymentResult>;
}

export type PaymentProvider = PaymentAuthorizer & PaymentCapturer;
