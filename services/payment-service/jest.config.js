module.exports = {
  displayName: 'payment-service',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.ts',
    '<rootDir>/tests/contract/**/*.test.ts',
  ],
  transform: {
    '^.+\\.ts$': ['@swc/jest'],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
