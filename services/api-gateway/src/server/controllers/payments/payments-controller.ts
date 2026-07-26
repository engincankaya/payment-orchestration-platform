import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../../constants';
import PaymentsGatewayService from '../../../services/payments-gateway-service';

export default class PaymentsController {
  private paymentsGatewayService: PaymentsGatewayService;

  constructor(deps: { paymentsGatewayService: PaymentsGatewayService }) {
    this.paymentsGatewayService = deps.paymentsGatewayService;
  }

  public create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsGatewayService.create({
        correlationId: String(req.headers[CORRELATION_ID_HEADER]),
        idempotencyKey: String(req.headers['idempotency-key']),
        merchantId: req.body.merchantId,
        amountMinor: req.body.amountMinor,
        currency: req.body.currency,
      });

      return res.status(result.statusCode).json({
        data: result.body,
        correlationId: req.headers[CORRELATION_ID_HEADER],
      });
    } catch (error) {
      return next(error);
    }
  };

  public getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsGatewayService.getById({
        correlationId: String(req.headers[CORRELATION_ID_HEADER]),
        paymentId: req.params.paymentId,
      });

      return res.status(200).json({
        data: result,
        correlationId: req.headers[CORRELATION_ID_HEADER],
      });
    } catch (error) {
      return next(error);
    }
  };

  public capture = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.paymentsGatewayService.capture({
        correlationId: String(req.headers[CORRELATION_ID_HEADER]),
        idempotencyKey: String(req.headers['idempotency-key']),
        paymentId: req.params.paymentId,
      });

      return res.status(result.statusCode).json({
        data: result.body,
        correlationId: req.headers[CORRELATION_ID_HEADER],
      });
    } catch (error) {
      return next(error);
    }
  };
}
