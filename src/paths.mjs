// paths.mjs: where job-radar keeps its config and state.
//
//   JOB_RADAR_HOME   overrides the project root (absolute, or relative to cwd).
//                    Default: the repository root.
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function projectRoot() {
  const env = process.env.JOB_RADAR_HOME?.trim();
  return env ? path.resolve(env) : REPO_ROOT;
}
