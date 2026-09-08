/**
 * Starts the agent runner once, when the server boots.
 *
 * Keeping it in-process means the runner and the request handlers share one
 * store instance, so a trade written on a tick is visible to the next request
 * with no cache coherency problem.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_AGENTS === "1") return;
  // On Vercel a function does not stay alive between requests, so an interval
  // here would tick once and die with the invocation. `/api/tick`, driven by
  // the cron in vercel.json, is the clock there instead.
  if (process.env.VERCEL === "1") {
    console.log("[runner] serverless host — ticks come from the /api/tick cron");
    return;
  }
  const { runner } = await import("./lib/runner");
  runner.start();
}
