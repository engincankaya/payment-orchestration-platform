FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY packages/openapi-kit/package.json ./packages/openapi-kit/package.json
COPY services/ledger-service/package.json ./services/ledger-service/package.json
RUN npm ci

COPY packages/openapi-kit/tsconfig.json ./packages/openapi-kit/tsconfig.json
COPY packages/openapi-kit/src ./packages/openapi-kit/src
COPY services/ledger-service/tsconfig.json ./services/ledger-service/tsconfig.json
COPY services/ledger-service/src ./services/ledger-service/src

RUN npm run build --workspace @payment-orchestration-platform/openapi-kit
RUN npm run build --workspace @payment-orchestration-platform/ledger-service

WORKDIR /app/services/ledger-service

EXPOSE 8080

CMD ["npm", "start"]
