import { IRouteSettings } from '@payment-orchestration-platform/openapi-kit';
import { PaymentsRoutes } from './payments';

export const Routes: IRouteSettings[] = [...PaymentsRoutes];
