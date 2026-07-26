import container from './bootstrap/container';
import type PaymentServiceBootstrap from './bootstrap/payment-service-bootstrap';

async function main() {
  const bootstrap = container.resolve<PaymentServiceBootstrap>(
    'paymentServiceBootstrap',
  );

  process.once('SIGTERM', () => {
    void bootstrap.handleSignal('SIGTERM').catch(handleFatalError);
  });
  process.once('SIGINT', () => {
    void bootstrap.handleSignal('SIGINT').catch(handleFatalError);
  });

  try {
    await bootstrap.bootstrap();
  } catch (error) {
    await bootstrap.shutdown().catch(() => undefined);
    throw error;
  }
}

function handleFatalError(error: unknown) {
  console.error('payment-service fatal error', error);
  process.exitCode = 1;
}

void main().catch(handleFatalError);
