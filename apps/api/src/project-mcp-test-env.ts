// The database package validates DATABASE_URL during module evaluation. These
// unit tests inject repositories and do not connect, so a lazy dummy URL is
// sufficient when the worktree environment has not already provided one.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
