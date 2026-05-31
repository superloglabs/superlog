import { config as loadDotenv } from "dotenv";
const portlessPort = process.env.PORTLESS_URL ? process.env.PORT : undefined;
loadDotenv();
loadDotenv({ path: ".env.local", override: true });
if (process.env.SUPERLOG_ENV_FILE) {
  loadDotenv({ path: process.env.SUPERLOG_ENV_FILE, override: true });
}
if (portlessPort) process.env.PORT = portlessPort;
