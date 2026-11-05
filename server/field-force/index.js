// Field Force: the Field Force Activation plan, built as a module of its own (see README.md
// in this folder). Everything it does starts here, so FIELD_FORCE=off removes it whole: no
// routes, no morning clock, no menu.
import { registerActivation, runActivation } from "./activation.js";

export const fieldForceEnabled = (env = process.env) => String(env.FIELD_FORCE ?? "on").trim().toLowerCase() !== "off";

export function registerFieldForce(router, app, env = process.env) {
  if (!fieldForceEnabled(env)) return;
  app.features.field_force = true;
  registerActivation(router, app);
}

// One pass of every scheduled Field Force step; the tests call this with their own clock.
export async function runFieldForce(app) {
  await runActivation(app);
}

export function scheduleFieldForce(app, env = process.env) {
  if (!fieldForceEnabled(env)) return;
  const run = () => runFieldForce(app).catch((e) => console.error("Field Force failed:", e.message));
  void run();
  setInterval(run, 60000).unref();
}
