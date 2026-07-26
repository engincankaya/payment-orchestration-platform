import ApiError from '../../types/errors/api-error';

export const PaymentStatus = {
  CREATED: 'CREATED',
  AUTHORIZED: 'AUTHORIZED',
  FAILED: 'FAILED',
  CAPTURED: 'CAPTURED',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
} as const;

export type PaymentStatusValue = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const allowedTransitions: Record<PaymentStatusValue, readonly PaymentStatusValue[]> = {
  [PaymentStatus.CREATED]: [PaymentStatus.AUTHORIZED, PaymentStatus.FAILED],
  [PaymentStatus.AUTHORIZED]: [PaymentStatus.CAPTURED, PaymentStatus.CAPTURE_FAILED],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CAPTURED]: [],
  [PaymentStatus.CAPTURE_FAILED]: [],
};

export default class PaymentStateService {
  /** Ensures that a payment status transition is allowed. */
  public ensureTransition = (
    currentStatus: PaymentStatusValue,
    targetStatus: PaymentStatusValue,
  ): void => {
    if (allowedTransitions[currentStatus].includes(targetStatus)) {
      return;
    }

    throw new ApiError({
      code: 'INVALID_PAYMENT_STATUS_TRANSITION',
      message: `Payment status cannot transition from ${currentStatus} to ${targetStatus}`,
      statusCode: 409,
    });
  };

  /** Ensures that a payment is currently eligible for capture. */
  public ensureCanCapture = (payment: { status: string }): void => {
    if (payment.status === PaymentStatus.AUTHORIZED) {
      return;
    }

    throw new ApiError({
      code: 'PAYMENT_NOT_CAPTURABLE',
      message: 'Payment is not capturable',
      statusCode: 409,
    });
  };
}
