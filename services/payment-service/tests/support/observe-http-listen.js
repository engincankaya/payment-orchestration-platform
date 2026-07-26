const http = require('node:http');
const path = require('node:path');

const originalListen = http.Server.prototype.listen;

http.Server.prototype.listen = function observeListen(...args) {
  if (process.send) {
    process.send({ type: 'http-listen' });
  }

  return originalListen.apply(this, args);
};

require('ts-node/register/transpile-only');
require(path.resolve(
  process.cwd(),
  'services/payment-service/src/index.ts',
));
