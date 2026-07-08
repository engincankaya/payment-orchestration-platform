module.exports = {
  displayName: 'payment-service-integration',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['@swc/jest'],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
