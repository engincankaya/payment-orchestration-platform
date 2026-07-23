import PaymentStateService from '../../src/services/payments/payment-state-service';
import ApiError from '../../src/types/errors/api-error';

const paymentStatuses = [
  'CREATED',
  'AUTHORIZED',
  'FAILED',
  'CAPTURED',
  'CAPTURE_FAILED',
] as const;

type PaymentStatus = (typeof paymentStatuses)[number];

const allowedTransitions = new Set<string>([
  'CREATED->AUTHORIZED',
  'CREATED->FAILED',
  'AUTHORIZED->CAPTURED',
  'AUTHORIZED->CAPTURE_FAILED',
]);

const transitionCases = paymentStatuses.flatMap((from) =>
  paymentStatuses.map((to) => ({
    allowed: allowedTransitions.has(`${from}->${to}`),
    from,
    to,
  })),
);

describe('PaymentStateService', () => {
  const service = new PaymentStateService();

  it.each(transitionCases)(
    '$from -> $to is allowed: $allowed',
    ({ allowed, from, to }) => {
      const transition = () => service.ensureTransition(from, to);

      if (allowed) {
        expect(transition).not.toThrow();
        return;
      }

      expect(transition).toThrow(ApiError);
    },
  );

  it.each(paymentStatuses)(
    'allows capture only from AUTHORIZED (status: %s)',
    (status: PaymentStatus) => {
      const captureCheck = () => service.ensureCanCapture({ status });

      if (status === 'AUTHORIZED') {
        expect(captureCheck).not.toThrow();
        return;
      }

      expect(captureCheck).toThrow(
        expect.objectContaining({
          code: 'PAYMENT_NOT_CAPTURABLE',
          statusCode: 409,
        }),
      );
    },
  );
});
