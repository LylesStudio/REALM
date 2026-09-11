const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "PostgreSQL verification is required but DATABASE_URL is missing. Copy .env.example to .env.local.",
  );
}

const url = new URL(connectionString);
const hostname = url.hostname.replace(/^\[|\]$/g, "");
if (
  !["postgres:", "postgresql:"].includes(url.protocol)
  || !["127.0.0.1", "localhost", "::1"].includes(hostname)
  || [...url.searchParams].length > 0
) {
  throw new Error(
    "PostgreSQL verification accepts only a query-free local loopback DATABASE_URL.",
  );
}

console.log(`PostgreSQL verification is restricted to ${hostname}.`);
