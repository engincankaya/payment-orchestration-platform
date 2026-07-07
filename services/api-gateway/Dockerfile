FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY packages/openapi-kit/package.json ./packages/openapi-kit/package.json
COPY services/api-gateway/package.json ./services/api-gateway/package.json
RUN npm ci

COPY packages/openapi-kit/tsconfig.json ./packages/openapi-kit/tsconfig.json
COPY packages/openapi-kit/src ./packages/openapi-kit/src
COPY services/api-gateway/tsconfig.json ./services/api-gateway/tsconfig.json
COPY services/api-gateway/src ./services/api-gateway/src

RUN npm run build --workspace @payment-orchestration-platform/openapi-kit
RUN npm run build --workspace @paybridge/api-gateway

WORKDIR /app/services/api-gateway

EXPOSE 8080

CMD ["npm", "start"]
