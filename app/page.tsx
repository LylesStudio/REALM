import { requirePageSession } from "../modules/identity/server-gate.ts";
import { RealmClient } from "./realm-client";

export default async function Home() {
  await requirePageSession("/");
  return <RealmClient />;
}
