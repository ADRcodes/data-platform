import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");

const explicitPath = process.env.DP_ENV_PATH && path.resolve(process.env.DP_ENV_PATH);
const defaultPath = path.resolve(ROOT_DIR, ".env");
const secondaryPath = path.resolve(ROOT_DIR, ".env.local");

const attempted = new Set();

function loadEnvFile(filePath) {
  if (!filePath || attempted.has(filePath)) return;
  attempted.add(filePath);
  if (!fs.existsSync(filePath)) return;
  dotenv.config({ path: filePath });
}

loadEnvFile(explicitPath);
loadEnvFile(defaultPath);
loadEnvFile(secondaryPath);
