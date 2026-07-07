import PaymentServiceClient from '../clients/payment-service-client';

export interface CreatePaymentGatewayCommand {
  correlationId: string;
  idempotencyKey: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

export interface GetPaymentGatewayQuery {
  correlationId: string;
  paymentId: string;
}

export default class PaymentsGatewayService {
  private paymentServiceClient: PaymentServiceClient;

  constructor(deps: { paymentServiceClient: PaymentServiceClient }) {
    this.paymentServiceClient = deps.paymentServiceClient;
  }

  public create = async (command: CreatePaymentGatewayCommand) => {
    return this.paymentServiceClient.create(command);
  };

  public getById = async (query: GetPaymentGatewayQuery) => {
    return this.paymentServiceClient.getById(query);
  };
}
