import { RouteRequestValidation } from './route-validation';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface IRouteSettings {
  path: string;
  method: HttpMethod;
  controller: string;
  config: {
    tags: string[];
    description: string;
    validation: RouteRequestValidation;
    middlewares: string[];
  };
}
