import { NextFunction, Request, Response } from 'express';

import ExternalAuthService from '../../services/auth/external-auth-service';
import { getValidCorrelationId } from '../validations/common-validations';

export default function apiKeyAuthMiddleware(deps: { externalAuthService: ExternalAuthService }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = req.headers['x-api-key'];
      const authenticatedClient = await deps.externalAuthService.authenticateApiKey(
        typeof apiKey === 'string' ? apiKey : undefined,
      );

      if (!authenticatedClient) {
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing API key',
            details: null,
            correlationId: getValidCorrelationId(req.headers['x-correlation-id']),
          },
        });
      }

      res.locals.auth = authenticatedClient;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
