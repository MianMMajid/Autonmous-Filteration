import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Scheduled operation requires an explicitly provisioned persistent host.
// Existing directories avoid silently bootstrapping on an unmounted volume.
const { latestRunId, readRunRecord } = await import("../src/run/outputs.ts");
const { verifyOutputDirectory } = await import("../src/run/integrity.ts");
const names = ["DATA_DIR", "BACKUP_DIR"];
const paths = [];
for (const name of names) {
  const path = process.env[name];
  if (!path || !isAbsolute(path) || /[\r\n]/.test(path))
    throw new Error(`${name} must be an absolute provisioned directory`);
  await access(path);
  if ((await readFile(join(path, ".deployment-ready"), "utf8")).trim() !== "pulley-state-v1")
    throw new Error(`${name} requires its provisioned-volume readiness marker`);
  paths.push(await realpath(path));
}
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};
const [data, backup] = paths;
if (within(data, backup) || within(backup, data))
  throw new Error("State and backups must be separate directories");
if (paths.some((path) => within(resolve(process.env.GITHUB_WORKSPACE ?? process.cwd()), path)))
  throw new Error("Persistent state must live outside the checkout");
if (process.env["SYNC_ENABLED"] !== "true")
  throw new Error(
    "Set SYNC_ENABLED=true only after provisioning state, backups, independent monitoring and an operator",
  );

const published = await latestRunId(data);
if (!published)
  throw new Error("Bootstrap and review a publication manually before enabling unattended sync");
await readRunRecord(data, published);
await verifyOutputDirectory(join(data, "out", published), published);

const heartbeat = process.env["SYNC_HEARTBEAT_URL"];
if (!heartbeat || !URL.canParse(heartbeat) || new URL(heartbeat).protocol !== "https:")
  throw new Error("Configure an HTTPS independent heartbeat endpoint before unattended runs");
