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
  const { runner } = await import("./lib/runner");
  runner.start();
}
