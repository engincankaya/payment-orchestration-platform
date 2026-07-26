import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../constants';
import { getValidCorrelationId } from '../validations/common-validations';

export default function correlationIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incomingCorrelationId = req.headers[CORRELATION_ID_HEADER];
    if (incomingCorrelationId !== undefined) {
      const validCorrelationId = getValidCorrelationId(incomingCorrelationId);

      if (validCorrelationId) {
        res.setHeader(CORRELATION_ID_HEADER, validCorrelationId);
      }

      return next();
    }

    const correlationId = randomUUID();
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    return next();
  };
}
