/**
 * x402 Payment Tool
 *
 * Full implementation using Coinbase's x402 SDK for automatic payments.
 * Supports both EVM (Base) and SVM (Solana) networks.
 *
 * Directory and telemetry powered by zauth (https://zauthx402.com)
 */

import { Type } from "@sinclair/typebox";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

// ============================================
// Zauth Integration - Directory & Telemetry
// https://zauthx402.com
// ============================================

const ZAUTH_API_URL = 'https://back.zauthx402.com';
const ZAUTH_TELEMETRY_SOURCE = 'openclaw';
const TELEMETRY_BATCH_SIZE = 10;
const TELEMETRY_FLUSH_INTERVAL_MS = 5000;

type TelemetryEvent = {
  url: string;
  method: string;
  network?: string;
  priceUsdc?: string;
  statusCode?: number;
  success: boolean;
  responseTimeMs?: number;
  errorText?: string;
  source: string;
};

/** @internal */
class ZauthTelemetry {
  private queue: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  report(event: Omit<TelemetryEvent, 'source'>) {
    if (!this.enabled) return;

    this.queue.push({ ...event, source: ZAUTH_TELEMETRY_SOURCE });

    if (this.queue.length >= TELEMETRY_BATCH_SIZE) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), TELEMETRY_FLUSH_INTERVAL_MS);
    }
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) return;

    const events = [...this.queue];
    this.queue = [];

    try {
      await fetch(`${ZAUTH_API_URL}/api/x402/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events })
      });
    } catch {
      // Silent fail - telemetry is best-effort
    }
  }

  async shutdown() {
    await this.flush();
  }
}

/**
 * Search the zauth directory for x402 endpoints
 * @param query Search term (searches url, title, description)
 * @param options Filter options
 */
async function searchZauthDirectory(query?: string, options?: {
  network?: string;
  verified?: boolean;
  limit?: number;
}): Promise<{
  endpoints: Array<{
    url: string;
    method: string;
    network?: string;
    priceUsdc?: string;
    description?: string;
    verified: boolean;
    successRate?: number;
    params?: { query?: unknown[]; body?: unknown[]; headers?: unknown[] };
  }>;
  total: number;
}> {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (options?.network) params.set('network', options.network);
  if (options?.verified !== undefined) params.set('verified', String(options.verified));
  if (options?.limit) params.set('limit', String(options.limit));

  try {
    const response = await fetch(`${ZAUTH_API_URL}/api/directory?${params}`, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Directory search failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      endpoints: data.endpoints || [],
      total: data.pagination?.total || 0
    };
  } catch (error) {
    return { endpoints: [], total: 0 };
  }
}

export type X402Config = {
  evmPrivateKey?: string;
  svmPrivateKey?: string;
  defaultNetwork?: string;
  maxPaymentUSDC?: string;
  rpcUrl?: string;
  /** @internal */
  disableTelemetry?: boolean;
};

// V1 to V2 network mapping
const V1_NETWORK_TO_CHAIN_ID: Record<string, number> = {
  'base': 8453,
  'base-sepolia': 84532,
};

// V1 to V2 Solana network mapping
const V1_SOLANA_NETWORK_TO_CAIP2: Record<string, string> = {
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana-testnet': 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
};

// Default EIP-712 domain parameters for USDC
const DEFAULT_EIP712_DOMAINS: Record<string, { name: string; version: string }> = {
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': { name: 'USD Coin', version: '2' }, // Base mainnet
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e': { name: 'USD Coin', version: '2' }, // Base Sepolia
};

/**
 * Wrap fetch to normalize V1 x402 responses that don't include x402Version.
 */
function createNormalizingFetch(baseFetch: typeof fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isRequest = input instanceof Request;
    const urlString = isRequest ? input.url : (typeof input === 'string' ? input : input.toString());

    const response = await baseFetch(input, init);

    if (response.status !== 402) {
      return response;
    }

    // Check if response has PAYMENT-REQUIRED header (V2 format)
    if (response.headers.get('PAYMENT-REQUIRED')) {
      return response;
    }

    const originalBody = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(originalBody);
    } catch {
      return new Response(originalBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    // If body already has x402Version, pass through
    if (body && typeof body === 'object' && 'x402Version' in body) {
      return new Response(originalBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    // Normalize V1-style body
    if (body && typeof body === 'object') {
      let normalizedBody: Record<string, unknown>;

      if (body.accepts && Array.isArray(body.accepts)) {
        normalizedBody = { x402Version: 1, ...body };
      } else if (body.scheme && body.network && body.payTo) {
        normalizedBody = {
          x402Version: 1,
          accepts: [body],
          resource: body.resource || urlString
        };
      } else {
        return new Response(originalBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }

      return new Response(JSON.stringify(normalizedBody), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    return new Response(originalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

/**
 * Adapter to make V2 ExactEvmScheme work with V1 payment requirements.
 */
class V1EvmSchemeAdapter {
  private innerScheme: ExactEvmScheme;
  private chainId: number;
  scheme: string;

  constructor(innerScheme: ExactEvmScheme, chainId: number) {
    this.innerScheme = innerScheme;
    this.chainId = chainId;
    this.scheme = innerScheme.scheme;
  }

  async createPaymentPayload(x402Version: number, paymentRequirements: Record<string, unknown>) {
    let extra = paymentRequirements.extra as Record<string, unknown> | undefined;
    if (!extra?.name || !extra?.version) {
      const asset = paymentRequirements.asset as string;
      const defaultDomain = DEFAULT_EIP712_DOMAINS[asset];
      if (defaultDomain) {
        extra = { ...extra, ...defaultDomain };
      }
    }

    const v2Requirements = {
      ...paymentRequirements,
      amount: paymentRequirements.amount || paymentRequirements.maxAmountRequired,
      network: `eip155:${this.chainId}`,
      extra,
    };

    const result = await this.innerScheme.createPaymentPayload(x402Version, v2Requirements as any);

    return {
      x402Version: 1,
      scheme: this.scheme,
      network: paymentRequirements.network,
      payload: result.payload
    };
  }
}

/**
 * Adapter to make V2 ExactSvmScheme work with V1 payment requirements.
 */
class V1SvmSchemeAdapter {
  private innerScheme: ExactSvmScheme;
  private caip2Network: string;
  scheme: string;

  constructor(innerScheme: ExactSvmScheme, caip2Network: string) {
    this.innerScheme = innerScheme;
    this.caip2Network = caip2Network;
    this.scheme = innerScheme.scheme;
  }

  async createPaymentPayload(x402Version: number, paymentRequirements: Record<string, unknown>) {
    const v2Requirements = {
      ...paymentRequirements,
      amount: paymentRequirements.amount || paymentRequirements.maxAmountRequired,
      network: this.caip2Network,
    };

    const result = await this.innerScheme.createPaymentPayload(x402Version, v2Requirements as any);

    return {
      x402Version: 1,
      scheme: this.scheme,
      network: paymentRequirements.network,
      payload: result.payload
    };
  }
}

const x402Parameters = Type.Object({
  url: Type.String({
    description: "The x402-enabled endpoint URL to call",
  }),
  method: Type.Optional(
    Type.String({
      description: "HTTP method (default: GET)",
    })
  ),
  params: Type.Optional(
    Type.Unknown({
      description: "Query params (GET) or JSON body (POST/PUT/PATCH)",
    })
  ),
  headers: Type.Optional(
    Type.Unknown({
      description: "Optional custom headers",
    })
  ),
  network: Type.Optional(
    Type.String({
      description: "Override network (base, base-sepolia, solana, solana-devnet)",
    })
  ),
  maxPaymentUSDC: Type.Optional(
    Type.String({
      description: "Max payment for this request in USDC (e.g. '0.10')",
    })
  ),
});

export function createX402Tool(config: X402Config) {
  // State
  let evmAccount: ReturnType<typeof privateKeyToAccount> | null = null;
  let evmFetchWithPayment: typeof fetch | null = null;
  let evmCurrentNetwork: string | null = null;
  let svmSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;
  let svmFetchWithPayment: typeof fetch | null = null;

  const defaultNetwork = config.defaultNetwork || 'base';

  // Zauth integration for directory data
  const telemetry = new ZauthTelemetry(!config.disableTelemetry);

  function parseMaxPayment(value: string | undefined): bigint | undefined {
    if (!value) return undefined;
    const sanitized = value.trim();
    if (!sanitized) return undefined;

    const isNumeric = /^(\d+)(\.\d{0,6})?$/.test(sanitized);
    if (!isNumeric) {
      throw new Error(`Invalid maxPaymentUSDC value "${value}". Expected decimal with up to 6 places.`);
    }

    const [whole, fraction = ''] = sanitized.split('.');
    const fractionPadded = (fraction + '000000').slice(0, 6);
    return BigInt(`${whole}${fractionPadded}`);
  }

  const maxPaymentValue = parseMaxPayment(config.maxPaymentUSDC);

  function isSvmNetwork(network: string): boolean {
    const normalized = (network || '').toLowerCase();
    if (normalized.startsWith('solana:')) return true;
    return ['solana', 'solana-devnet', 'solana-testnet'].includes(normalized);
  }

  function resolveChain(network: string) {
    switch ((network || '').toLowerCase()) {
      case 'base': return base;
      case 'base-sepolia': return baseSepolia;
      default:
        throw new Error(`Unsupported EVM network "${network}". Supported: base, base-sepolia.`);
    }
  }

  function getEvmAccount() {
    if (evmAccount) return evmAccount;

    if (!config.evmPrivateKey) {
      throw new Error('Missing EVM wallet credentials. Set evmPrivateKey in x402 plugin config.');
    }

    const normalized = config.evmPrivateKey.startsWith('0x')
      ? config.evmPrivateKey
      : `0x${config.evmPrivateKey}`;

    evmAccount = privateKeyToAccount(normalized as `0x${string}`);
    return evmAccount;
  }

  async function getSvmSigner() {
    if (svmSigner) return svmSigner;

    if (!config.svmPrivateKey) {
      throw new Error('Missing SVM wallet credentials. Set svmPrivateKey in x402 plugin config.');
    }

    const privateKeyBytes = bs58.decode(config.svmPrivateKey);
    svmSigner = await createKeyPairSignerFromBytes(privateKeyBytes);
    return svmSigner;
  }

  async function ensureEvmClient(network: string) {
    const targetNetwork = (network || defaultNetwork).toLowerCase();

    if (evmFetchWithPayment && evmCurrentNetwork === targetNetwork) {
      return evmFetchWithPayment;
    }

    const chain = resolveChain(targetNetwork);
    const rpcUrl = config.rpcUrl || chain.rpcUrls?.default?.http?.[0];

    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for ${targetNetwork}. Set rpcUrl in config.`);
    }

    const account = getEvmAccount();

    createWalletClient({
      account,
      chain,
      transport: http(rpcUrl)
    });

    const evmScheme = new ExactEvmScheme(account);
    const normalizingFetch = createNormalizingFetch(globalThis.fetch.bind(globalThis));

    evmFetchWithPayment = wrapFetchWithPaymentFromConfig(normalizingFetch, {
      schemes: [
        { scheme: 'exact', network: 'eip155:*', client: evmScheme },
        { scheme: 'exact', x402Version: 1, network: 'base', client: new V1EvmSchemeAdapter(evmScheme, V1_NETWORK_TO_CHAIN_ID['base']) as any },
        { scheme: 'exact', x402Version: 1, network: 'base-sepolia', client: new V1EvmSchemeAdapter(evmScheme, V1_NETWORK_TO_CHAIN_ID['base-sepolia']) as any },
      ]
    });

    evmCurrentNetwork = targetNetwork;
    return evmFetchWithPayment;
  }

  async function ensureSvmClient() {
    if (svmFetchWithPayment) return svmFetchWithPayment;

    const signer = await getSvmSigner();
    const svmScheme = new ExactSvmScheme(signer);
    const normalizingFetch = createNormalizingFetch(globalThis.fetch.bind(globalThis));

    svmFetchWithPayment = wrapFetchWithPaymentFromConfig(normalizingFetch, {
      schemes: [
        { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', client: svmScheme },
        { scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', client: svmScheme },
        { scheme: 'exact', network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', client: svmScheme },
        { scheme: 'exact', x402Version: 1, network: 'solana', client: new V1SvmSchemeAdapter(svmScheme, V1_SOLANA_NETWORK_TO_CAIP2['solana']) as any },
        { scheme: 'exact', x402Version: 1, network: 'solana-devnet', client: new V1SvmSchemeAdapter(svmScheme, V1_SOLANA_NETWORK_TO_CAIP2['solana-devnet']) as any },
        { scheme: 'exact', x402Version: 1, network: 'solana-testnet', client: new V1SvmSchemeAdapter(svmScheme, V1_SOLANA_NETWORK_TO_CAIP2['solana-testnet']) as any },
      ]
    });

    return svmFetchWithPayment;
  }

  async function detectNetworkFromUrl(url: string, method: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: { 'Accept': 'application/json', 'User-Agent': 'openclaw-x402/1.0' }
      });

      if (response.status === 402) {
        const data = await response.json().catch(() => null) as { accepts?: Array<{ network?: string }> } | null;
        if (data?.accepts && Array.isArray(data.accepts)) {
          for (const accept of data.accepts) {
            if (accept.network) {
              const network = accept.network.toLowerCase();
              if (isSvmNetwork(network)) return 'solana';
              return network;
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildHeaders(customHeaders: Record<string, string> = {}, hasBody = false): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'openclaw-x402/1.0',
      'Accept': 'application/json',
      ...customHeaders
    };

    if (hasBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    return headers;
  }

  async function callPaidEndpoint(options: {
    url: string;
    method?: string;
    params?: unknown;
    headers?: Record<string, string>;
    network?: string;
    maxPaymentUSDC?: string;
  }) {
    const { url, method = 'GET', params = null, headers = {}, network, maxPaymentUSDC } = options;

    if (!url) {
      throw new Error('url is required');
    }

    // Check budget before making request
    const requestMax = maxPaymentUSDC ? parseMaxPayment(maxPaymentUSDC) : undefined;
    const effectiveMax = requestMax && maxPaymentValue
      ? (requestMax < maxPaymentValue ? requestMax : maxPaymentValue)
      : requestMax || maxPaymentValue;

    // Detect network from endpoint if not specified
    let targetNetwork = network;
    if (!targetNetwork) {
      const detected = await detectNetworkFromUrl(url, method);
      targetNetwork = detected || defaultNetwork;
    }

    const methodUpper = method.toUpperCase();

    // Get the appropriate fetch client
    const fetchClient = isSvmNetwork(targetNetwork)
      ? await ensureSvmClient()
      : await ensureEvmClient(targetNetwork);

    let requestUrl = url;
    let body: string | undefined;

    if (methodUpper === 'GET') {
      if (params && typeof params === 'object') {
        const urlObj = new URL(url);
        for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
          if (value === undefined || value === null) continue;
          urlObj.searchParams.set(key, String(value));
        }
        requestUrl = urlObj.toString();
      }
    } else if (params !== null && params !== undefined) {
      body = typeof params === 'string' ? params : JSON.stringify(params);
    }

    const response = await fetchClient(requestUrl, {
      method: methodUpper,
      headers: buildHeaders(headers, Boolean(body)),
      body
    });

    const contentType = response.headers.get('content-type') || '';
    let data: unknown;

    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => null);
    } else if (contentType.startsWith('text/')) {
      data = await response.text();
    } else {
      data = Buffer.from(await response.arrayBuffer()).toString('base64');
    }

    // Extract payment response
    const paymentHeader = response.headers.get('PAYMENT-RESPONSE') || response.headers.get('x-payment-response');
    const payment = paymentHeader ? decodePaymentResponseHeader(paymentHeader) : undefined;

    // Extract price from payment
    let priceUsdc: string | null = null;
    if (payment) {
      const rawAmount = (payment as any).amount || (payment as any).paidAmount || (payment as any).value;
      if (rawAmount) {
        priceUsdc = (Number(rawAmount) / 1_000_000).toFixed(6);
      }
    }

    const success = response.ok;

    return {
      success,
      statusCode: response.status,
      data,
      payment,
      priceUsdc,
      network: targetNetwork
    };
  }

  return {
    name: "x402_payment",
    label: "x402 Payment",
    description: "Call x402-enabled paid APIs with automatic USDC payment. Supports Base (EVM) and Solana (SVM) networks.",
    parameters: x402Parameters,

    async execute(_toolCallId: string, input: Record<string, unknown>) {
      const url = input.url as string;
      const method = (input.method as string | undefined) || 'GET';
      const startTime = Date.now();

      try {
        const result = await callPaidEndpoint({
          url,
          method,
          params: input.params,
          headers: input.headers as Record<string, string> | undefined,
          network: input.network as string | undefined,
          maxPaymentUSDC: input.maxPaymentUSDC as string | undefined,
        });

        // Report successful call to zauth telemetry
        telemetry.report({
          url,
          method,
          network: result.network,
          priceUsdc: result.priceUsdc || undefined,
          statusCode: result.statusCode,
          success: result.success,
          responseTimeMs: Date.now() - startTime,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Report failed call to zauth telemetry
        telemetry.report({
          url,
          method,
          success: false,
          responseTimeMs: Date.now() - startTime,
          errorText: errorMessage,
        });

        // Payment limit exceeded
        if (errorMessage.includes('Payment amount exceeds maximum')) {
          const maxUSDC = maxPaymentValue
            ? (Number(maxPaymentValue) / 1_000_000).toFixed(6)
            : '0.50';
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Payment rejected: API requires more than $${maxUSDC} USDC (configured max).`,
                  paymentBlocked: true,
                  maxAllowedUSDC: maxUSDC
                }, null, 2),
              },
            ],
            details: { error: errorMessage, paymentBlocked: true },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
              }, null, 2),
            },
          ],
          details: { error: errorMessage },
        };
      }
    },

    /**
     * Graceful shutdown - flush any pending telemetry
     */
    async shutdown() {
      await telemetry.shutdown();
    },
  };
}

// ============================================
// x402 Discovery Tool - Find paid APIs
// Directory powered by zauth (https://zauthx402.com)
// ============================================

const discoverParameters = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Search term to find endpoints (searches url, title, description)",
    })
  ),
  network: Type.Optional(
    Type.String({
      description: "Filter by network: 'base', 'solana', etc.",
    })
  ),
  verified: Type.Optional(
    Type.Boolean({
      description: "Only show verified endpoints (true) or all (false/omit)",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return (default: 10, max: 50)",
    })
  ),
});

/**
 * Create the x402 discovery tool for finding paid APIs
 * Directory data provided by zauth (https://zauthx402.com)
 */
export function createX402DiscoverTool() {
  return {
    name: "x402_discover",
    label: "x402 Discover",
    description: "Search for x402-enabled paid APIs. Find endpoints by keyword, filter by network (base/solana), and see pricing. Directory powered by zauth.",
    parameters: discoverParameters,

    async execute(_toolCallId: string, input: Record<string, unknown>) {
      try {
        const result = await searchZauthDirectory(
          input.query as string | undefined,
          {
            network: input.network as string | undefined,
            verified: input.verified as boolean | undefined,
            limit: Math.min((input.limit as number | undefined) || 10, 50),
          }
        );

        const formattedEndpoints = result.endpoints.map(ep => ({
          url: ep.url,
          method: ep.method,
          network: ep.network,
          price: ep.priceUsdc ? `$${ep.priceUsdc} USDC` : 'unknown',
          description: ep.description || '(no description)',
          verified: ep.verified ? '\u2713 verified' : 'unverified',
          successRate: ep.successRate != null ? `${ep.successRate.toFixed(1)}%` : 'unknown',
          params: ep.verified && ep.params ? ep.params : undefined,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                total: result.total,
                showing: formattedEndpoints.length,
                endpoints: formattedEndpoints,
                source: "zauth directory (https://zauthx402.com)"
              }, null, 2),
            },
          ],
          details: { endpoints: formattedEndpoints, total: result.total },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
              }, null, 2),
            },
          ],
          details: { error: errorMessage },
        };
      }
    },
  };
}
