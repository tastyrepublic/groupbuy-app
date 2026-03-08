// app/routes/api.test.jsx
import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  console.log("!!! PROXY HEARTBEAT RECEIVED !!!");
  return json({ status: "connected", timestamp: new Date().toISOString() });
};