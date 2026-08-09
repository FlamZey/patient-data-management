# Architecture Decisions

## Technology choices

| Layer            | Choice                          | Why                                                                                                  |
| ---------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Frontend         | Next.js + TypeScript + Tailwind | Type safety, responsive UI, and a fast development experience                                        |
| Backend          | FastAPI + SQLAlchemy            | Fast API development, automatic OpenAPI docs, and an easy way to work with the database using an ORM |
| Database         | PostgreSQL                      | Reliable relational database for users, roles, permissions, teams, and locations                     |
| Containerization | Docker Compose                  | Single-command local setup and a consistent environment across machines                              |
