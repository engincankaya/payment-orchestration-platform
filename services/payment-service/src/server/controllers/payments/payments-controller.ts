import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../../constants';
import PaymentsService from '../../../services/payments/payments-service';

export default class PaymentsController {
  private paymentsService: PaymentsService;

  constructor(deps: { paymentsService: PaymentsService }) {
    this.paymentsService = deps.paymentsService;
  }

  public create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsService.create({
        correlationId: String(req.headers[CORRELATION_ID_HEADER]),
        idempotencyKey: String(req.headers['idempotency-key']),
        merchantId: req.body.merchantId,
        amountMinor: req.body.amountMinor,
        currency: req.body.currency,
      });

      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      return next(error);
    }
  };

  public getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsService.getById({
        paymentId: req.params.paymentId,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  };

  public capture = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsService.capture({
        correlationId: String(req.headers[CORRELATION_ID_HEADER]),
        idempotencyKey: String(req.headers['idempotency-key']),
        paymentId: req.params.paymentId,
      });

      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      return next(error);
    }
  };
}
