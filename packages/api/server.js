import "dotenv/config";
import express from "express";
import cors from "cors";
import logger from "../scraper/logger.js";
import { openDb } from "../scraper/db.js";
import createEventsRouter from "./routes/events.js";
import createAdminRouter from "./routes/admin.js";
import createMetricsHandler from "./routes/metrics.js";
import createDebugHandler from "./routes/debug.js";

const app = express();
app.use(cors());
app.use(express.json());

const db = openDb();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/events", createEventsRouter(db));
app.get("/metrics", createMetricsHandler(db));
app.get("/debug", createDebugHandler(db));
app.use("/admin", createAdminRouter(db));

const port = Number.parseInt(process.env.PORT ?? "3001", 10) || 3001;
app.listen(port, () => logger.info(`API on http://localhost:${port} — open /debug and /events`));
