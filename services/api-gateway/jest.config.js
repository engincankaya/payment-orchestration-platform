module.exports = {
  displayName: 'api-gateway',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['@swc/jest'],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
