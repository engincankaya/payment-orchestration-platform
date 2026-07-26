import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../../constants';
import timingSafeEquals from '../../utils/timing-safe-equals';
import { getValidCorrelationId } from '../validations/common-validations';

export default function internalAuthMiddleware(deps: { env: NodeJS.ProcessEnv }) {
  // Missing internal auth config must fail during route wiring, before the service accepts traffic.
  if (!deps.env.INTERNAL_SERVICE_TOKEN) {
    throw new Error('INTERNAL_SERVICE_TOKEN is required');
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers['x-internal-token'];

      const isAuthorized = timingSafeEquals(
        typeof token === 'string' ? token : undefined,
        deps.env.INTERNAL_SERVICE_TOKEN,
      );

      if (!isAuthorized) {
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing internal token',
            details: null,
            correlationId: getValidCorrelationId(req.headers[CORRELATION_ID_HEADER]),
          },
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
