import Fastify from "fastify";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const app = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] ?? "info",
  },
});

app.get("/api/health", async () => {
  return { status: "ok", uptime: process.uptime() };
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

export { app };
