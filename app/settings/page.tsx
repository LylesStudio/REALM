import { requirePageSession } from "../../modules/identity/server-gate.ts";
import { ModelSettingsClient } from "./settings-client";

export default async function SettingsPage() {
  await requirePageSession("/settings");
  return <ModelSettingsClient />;
}
