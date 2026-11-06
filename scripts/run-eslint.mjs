import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const eslintEntry = path.resolve("node_modules/eslint/bin/eslint.js");
const result = spawnSync(
  process.execPath,
  [eslintEntry, "app", "components", "lib", "--max-warnings", "689"],
  {
    stdio: "inherit",
    env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "false" },
  },
);

if (result.error) {
  console.error("Unable to start ESLint:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
