// This endpoint must belong to an independently operated missed-run monitor.
// Do not print the URL: it may carry a secret token.
const value = process.env["SYNC_HEARTBEAT_URL"];
if (!value || !URL.canParse(value) || new URL(value).protocol !== "https:")
  throw new Error("Configure an HTTPS SYNC_HEARTBEAT_URL before enabling unattended runs");
try {
  const response = await fetch(value, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Rejected");
} catch {
  throw new Error("Independent monitor heartbeat failed; verify its configuration and delivery");
}
