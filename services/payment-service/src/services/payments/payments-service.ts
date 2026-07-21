import { randomUUID } from 'crypto';

import PaymentsDataAccess, { PaymentRecord } from '../../data-access/payments/payments-data-access';
import ApiError from '../../types/errors/api-error';
import { Logger } from '../../utils/logger';
import IdempotencyService from '../idempotency/idempotency-service';
import ProviderRegistryService from '../providers/provider-registry-service';

export type PaymentsDataAccessPort = Pick<
  PaymentsDataAccess,
  'insert' | 'findById' | 'withTransaction'
>;
export type IdempotencyServicePort = Pick<
  IdempotencyService,
  'buildRequestHash' | 'getExistingOrStart' | 'markCompleted' | 'markFailed'
>;
export type ProviderRegistryServicePort = Pick<ProviderRegistryService, 'getDefaultProvider'>;

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

export interface CreatePaymentResult {
  statusCode: number;
  body: PaymentDto;
}

export default class PaymentsService {
  private paymentsDataAccess: PaymentsDataAccessPort;
  private idempotencyService: IdempotencyServicePort;
  private providerRegistryService: ProviderRegistryServicePort;
  private logger: Logger;

  constructor(deps: {
    paymentsDataAccess: PaymentsDataAccessPort;
    idempotencyService: IdempotencyServicePort;
    providerRegistryService: ProviderRegistryServicePort;
    logger: Logger;
  }) {
    this.paymentsDataAccess = deps.paymentsDataAccess;
    this.idempotencyService = deps.idempotencyService;
    this.providerRegistryService = deps.providerRegistryService;
    this.logger = deps.logger;
  }

  public create = async (command: CreatePaymentCommand): Promise<CreatePaymentResult> => {
    const requestHash = this.idempotencyService.buildRequestHash({
      merchantId: command.merchantId,
      amountMinor: command.amountMinor,
      currency: command.currency,
    });
    const reservedPaymentId = randomUUID();
    const idempotencyDecision = await this.idempotencyService.getExistingOrStart({
      scope: `payments:create:${command.merchantId}`,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      resource: {
        type: 'payment',
        id: reservedPaymentId,
      },
    });

    if (idempotencyDecision.type === 'COMPLETED') {
      return {
        statusCode: idempotencyDecision.responseStatusCode,
        body: idempotencyDecision.responseBody as PaymentDto,
      };
    }

    const paymentId = idempotencyDecision.resourceId;

    try {
      const provider = this.providerRegistryService.getDefaultProvider();
      const authorization = await provider.authorize({
        paymentId,
        merchantId: command.merchantId,
        amountMinor: command.amountMinor,
        currency: command.currency,
      });

      const now = new Date();
      const status = authorization.success ? PaymentStatus.AUTHORIZED : PaymentStatus.FAILED;

      const body = await this.paymentsDataAccess.withTransaction(async (trx) => {
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
        }, trx);
        const responseBody = this.toDto(payment);

        await this.idempotencyService.markCompleted({
          idempotencyRecordId: idempotencyDecision.recordId,
          responseStatusCode: 201,
          responseBody,
          resourceType: 'payment',
          resourceId: responseBody.id,
          trx,
        });

        return responseBody;
      });

      return { statusCode: 201, body };
    } catch (error) {
      await this.idempotencyService
        .markFailed({ idempotencyRecordId: idempotencyDecision.recordId })
        .catch((markFailedError) => {
          this.logger.error('Failed to mark idempotency record as failed', {
            idempotencyRecordId: idempotencyDecision.recordId,
            message:
              markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
            stack: markFailedError instanceof Error ? markFailedError.stack : undefined,
          });
        });

      throw error;
    }
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
