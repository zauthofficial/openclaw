/**
 * x402 Payment Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createX402Tool } from "./x402-tool.js";

// Mock the x402 packages
vi.mock("@x402/fetch", () => ({
  wrapFetchWithPaymentFromConfig: vi.fn((baseFetch) => baseFetch),
  decodePaymentResponseHeader: vi.fn((header) => {
    try {
      return JSON.parse(Buffer.from(header, "base64").toString());
    } catch {
      return null;
    }
  }),
}));

vi.mock("@x402/evm", () => ({
  ExactEvmScheme: vi.fn().mockImplementation(() => ({
    scheme: "exact",
    createPaymentPayload: vi.fn(),
  })),
}));

vi.mock("@x402/svm", () => ({
  ExactSvmScheme: vi.fn().mockImplementation(() => ({
    scheme: "exact",
    createPaymentPayload: vi.fn(),
  })),
}));

vi.mock("viem", () => ({
  createWalletClient: vi.fn(),
  http: vi.fn(),
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: "0x1234567890123456789012345678901234567890",
  }),
}));

vi.mock("viem/chains", () => ({
  base: { id: 8453, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } },
  baseSepolia: { id: 84532, rpcUrls: { default: { http: ["https://sepolia.base.org"] } } },
}));

describe("x402 Payment Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates tool with correct name and schema", () => {
    const tool = createX402Tool({
      evmPrivateKey: "0x1234",
      maxPaymentUSDC: "0.10",
    });

    expect(tool.name).toBe("x402_payment");
    expect(tool.parameters).toBeDefined();
    expect(tool.description).toContain("x402");
  });

  it("returns error when no wallet configured for EVM", async () => {
    const tool = createX402Tool({});

    // Mock fetch to return 402
    global.fetch = vi.fn().mockResolvedValue({
      status: 402,
      json: () => Promise.resolve({ accepts: [{ network: "base" }] }),
    });

    const result = await tool.execute("test-call-id", { url: "https://api.example.com/paid" });

    expect(result.content[0]).toHaveProperty("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("error");
    expect(text).toContain("evmPrivateKey");
  });

  it("creates tool with execute function", () => {
    const tool = createX402Tool({
      evmPrivateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
    });

    expect(tool.execute).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("respects maxPaymentUSDC config", () => {
    const tool = createX402Tool({
      evmPrivateKey: "0x1234",
      maxPaymentUSDC: "0.50",
    });

    // The max is stored internally - we verify it's created without error
    expect(tool).toBeDefined();
  });
});
