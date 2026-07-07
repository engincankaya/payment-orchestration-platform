FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY packages/openapi-kit/package.json ./packages/openapi-kit/package.json
COPY services/webhook-service/package.json ./services/webhook-service/package.json
RUN npm ci

COPY packages/openapi-kit/tsconfig.json ./packages/openapi-kit/tsconfig.json
COPY packages/openapi-kit/src ./packages/openapi-kit/src
COPY services/webhook-service/tsconfig.json ./services/webhook-service/tsconfig.json
COPY services/webhook-service/src ./services/webhook-service/src

RUN npm run build --workspace @payment-orchestration-platform/openapi-kit
RUN npm run build --workspace @paybridge/webhook-service

WORKDIR /app/services/webhook-service

EXPOSE 8080

CMD ["npm", "start"]
