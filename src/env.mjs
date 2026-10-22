// env.mjs: load .env from the project root (local runs). In GitHub Actions the
// same variables come from repository secrets, and nothing here is needed.
import path from 'path';
import dotenv from 'dotenv';
import { projectRoot } from './paths.mjs';

export function loadEnv() {
  dotenv.config({ path: path.join(projectRoot(), '.env'), quiet: true });
}
