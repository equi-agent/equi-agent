/** Starts the server over stdio like Claude would, lists its tools and runs the read + plan + execute flow. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: { ...process.env, EQUI_DEMO: "1" } as Record<string, string> }));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const show = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`\n===== ${name}${r.isError ? " (error)" : ""}\n${r.content.map((c) => c.text).join("\n")}`);
  return r.content.map((c) => c.text).join("\n");
};

await show("get_targets");
await show("get_portfolio");
await show("check_drift");
const plan = await show("plan_rebalance");
const id = plan.match(/Plan (\w+)/)?.[1];
await show("execute_rebalance", { plan_id: "nope", confirm: "EXECUTE" });
if (id) await show("execute_rebalance", { plan_id: id, confirm: "EXECUTE" });
await client.close();
