// Bootstrap for agentRun.test.ts. The @superlog/db client throws at
// import time when DATABASE_URL is unset, but these tests use a recording
// fake DB and never connect — so a dummy URL is sufficient.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
