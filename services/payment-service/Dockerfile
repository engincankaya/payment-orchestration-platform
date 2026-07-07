FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY packages/openapi-kit/package.json ./packages/openapi-kit/package.json
COPY services/payment-service/package.json ./services/payment-service/package.json
RUN npm ci

COPY packages/openapi-kit/tsconfig.json ./packages/openapi-kit/tsconfig.json
COPY packages/openapi-kit/src ./packages/openapi-kit/src
COPY services/payment-service/tsconfig.json ./services/payment-service/tsconfig.json
COPY services/payment-service/src ./services/payment-service/src

RUN npm run build --workspace @payment-orchestration-platform/openapi-kit
RUN npm run build --workspace @paybridge/payment-service

WORKDIR /app/services/payment-service

EXPOSE 8080

CMD ["npm", "start"]
