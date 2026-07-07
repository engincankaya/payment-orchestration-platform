import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../constants';

export default function correlationIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incomingCorrelationId = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof incomingCorrelationId === 'string' && incomingCorrelationId.length > 0
        ? incomingCorrelationId
        : randomUUID();

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    return next();
  };
}
