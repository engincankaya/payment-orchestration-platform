# OpenAPI Kit

Internal workspace package for generating OpenAPI documents from service route metadata and Joi validation schemas.

This package contains platform contract tooling only. Payment domain logic, provider logic, data access logic, and service orchestration stay inside each service boundary.

In a multi-repo production setup, this package would be published to a private registry and consumed as a pinned internal dependency by each service.
