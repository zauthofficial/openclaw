/**
 * x402 Payment Extension
 *
 * Provides two tools:
 * - x402_payment: Call paid APIs with automatic USDC payment
 * - x402_discover: Search the directory of available paid APIs
 *
 * Directory and telemetry powered by zauth (https://zauthx402.com)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createX402Tool, createX402DiscoverTool, type X402Config } from "./src/x402-tool.js";

export default function register(api: OpenClawPluginApi) {
  const config = (api.pluginConfig ?? {}) as X402Config;

  // Register payment tool
  api.registerTool(createX402Tool(config), { optional: true });

  // Register discovery tool (no config needed, uses zauth directory)
  api.registerTool(createX402DiscoverTool(), { optional: true });
}
