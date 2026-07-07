import { IRouteSettings } from '../../types/server/route-settings';
import { PaymentsRoutes } from './payments';

export const Routes: IRouteSettings[] = [...PaymentsRoutes];
