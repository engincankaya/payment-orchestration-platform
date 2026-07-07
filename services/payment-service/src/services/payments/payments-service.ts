import { randomUUID } from 'crypto';

import PaymentsDataAccess, { PaymentRecord } from '../../data-access/payments/payments-data-access';
import ApiError from '../../types/errors/api-error';
import ProviderRegistryService from '../providers/provider-registry-service';

export const PaymentStatus = {
  AUTHORIZED: 'AUTHORIZED',
  FAILED: 'FAILED',
} as const;

export type PaymentStatusValue = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export interface CreatePaymentCommand {
  correlationId: string;
  idempotencyKey: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

export interface GetPaymentQuery {
  paymentId: string;
}

export interface PaymentDto {
  id: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  status: string;
  provider: string;
  providerPaymentId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  createdAt: string;
}

export default class PaymentsService {
  private paymentsDataAccess: PaymentsDataAccess;
  private providerRegistryService: ProviderRegistryService;

  constructor(deps: {
    paymentsDataAccess: PaymentsDataAccess;
    providerRegistryService: ProviderRegistryService;
  }) {
    this.paymentsDataAccess = deps.paymentsDataAccess;
    this.providerRegistryService = deps.providerRegistryService;
  }

  public create = async (command: CreatePaymentCommand): Promise<PaymentDto> => {
    const paymentId = randomUUID();
    const provider = this.providerRegistryService.getDefaultProvider();
    const authorization = await provider.authorize({
      paymentId,
      merchantId: command.merchantId,
      amountMinor: command.amountMinor,
      currency: command.currency,
    });

    const now = new Date();
    const status = authorization.success ? PaymentStatus.AUTHORIZED : PaymentStatus.FAILED;
    const payment = await this.paymentsDataAccess.insert({
      id: paymentId,
      merchant_id: command.merchantId,
      amount_minor: command.amountMinor,
      currency: command.currency,
      status,
      provider: authorization.provider,
      provider_payment_id: authorization.providerPaymentId ?? null,
      failure_code: authorization.failureCode ?? null,
      failure_message: authorization.failureMessage ?? null,
      authorized_at: authorization.success ? now : null,
      failed_at: authorization.success ? null : now,
    });

    return this.toDto(payment);
  };

  public getById = async (query: GetPaymentQuery): Promise<PaymentDto> => {
    const payment = await this.paymentsDataAccess.findById(query.paymentId);

    if (!payment) {
      throw new ApiError({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
        statusCode: 404,
      });
    }

    return this.toDto(payment);
  };

  private toDto(payment: PaymentRecord): PaymentDto {
    return {
      id: payment.id,
      merchantId: payment.merchant_id,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      providerPaymentId: payment.provider_payment_id,
      failureCode: payment.failure_code,
      failureMessage: payment.failure_message,
      createdAt: new Date(payment.created_at).toISOString(),
    };
  }
}
