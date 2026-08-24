/**
 * Verifies the GitHub App credentials without sending anything.
 *
 * Run this first, before wiring up Discord: it isolates "my App setup is wrong"
 * from "my bot code is wrong", which are otherwise hard to tell apart.
 *
 *   npm run check-github
 */
import { loadEnv } from "../src/core/env.js";
import { createLogger } from "../src/core/logger.js";
import { createGitHubClient } from "../src/lib/github.js";

const env = loadEnv();
const logger = createLogger({ level: "warn", pretty: true });
const github = createGitHubClient(env, logger);

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

console.log("\nChecking GitHub App configuration...\n");

let failed = false;

try {
  const { data: app } = await github.rest.apps.getAuthenticated();
  ok(`Authenticated as GitHub App: ${app?.name ?? "(unknown)"}`);
} catch (err) {
  failed = true;
  bad("Could not authenticate as the App.");
  console.log("    Check GITHUB_APP_ID and the private key.");
  console.log(`    ${err instanceof Error ? err.message : String(err)}`);
}

try {
  const { data: installation } = await github.rest.apps.getInstallation({
    installation_id: Number(env.GITHUB_INSTALLATION_ID),
  });
  const account = installation.account;
  const login = account && "login" in account ? account.login : "(unknown)";
  ok(`Installed on: ${login}`);

  if (login.toLowerCase() !== env.GITHUB_ORG.toLowerCase()) {
    failed = true;
    bad(`GITHUB_ORG is "${env.GITHUB_ORG}" but the App is installed on "${login}".`);
  }

  const members = installation.permissions?.members;
  if (members === "write") {
    ok('Permission "members: write" granted.');
  } else {
    failed = true;
    bad(`Permission "members" is "${members ?? "missing"}", needs "write".`);
    console.log("    App settings -> Permissions -> Organization -> Members: Read and write.");
    console.log("    Changing permissions requires the org owner to approve the request.");
  }
} catch (err) {
  failed = true;
  bad("Could not read the installation.");
  console.log("    Check GITHUB_INSTALLATION_ID (it's the number at the end of the install URL).");
  console.log(`    ${err instanceof Error ? err.message : String(err)}`);
}

try {
  const { data: org } = await github.rest.orgs.get({ org: env.GITHUB_ORG });
  ok(`Reached org "${org.login}" (${org.plan?.name ?? "plan hidden"}).`);
} catch {
  failed = true;
  bad(`Could not read org "${env.GITHUB_ORG}".`);
}

console.log(
  env.GITHUB_DRY_RUN
    ? "\n  \x1b[33m!\x1b[0m GITHUB_DRY_RUN=true — invitations will be logged, not sent.\n"
    : "\n  \x1b[33m!\x1b[0m GITHUB_DRY_RUN=false — invitations are REAL.\n",
);

process.exit(failed ? 1 : 0);
