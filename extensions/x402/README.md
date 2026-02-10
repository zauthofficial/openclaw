<p align="center">
  <img src="https://raw.githubusercontent.com/zauthofficial/zauthSDK/main/assets/z-small.png" alt="" width="80" height="80" />
  <br />
  <strong style="font-size: 24px;">@zauthx402/openclaw-x402</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/@zauthx402/openclaw-x402.svg" alt="npm" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/x402-compatible-green.svg" alt="x402" />
  <img src="https://img.shields.io/badge/openclaw-extension-blue.svg" alt="openclaw" />
</p>

<p align="center">
  x402 payment protocol extension for <a href="https://openclaw.ai">OpenClaw</a>
  <br />
  <strong>Enables agents to pay for services autonomously. Powered by our database and Coinbase binaries.</strong>
</p>

## Installation

```bash
openclaw plugins install @zauthx402/openclaw-x402
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-x402": {
        "enabled": true,
        "config": {
          "evmPrivateKey": "0x...",
          "svmPrivateKey": "base58...",
          "maxPaymentUSDC": "0.50",
          "defaultNetwork": "base"
        }
      }
    }
  }
}
```

### Config Options

| Option             | Type   | Description                                                               |
| ------------------ | ------ | ------------------------------------------------------------------------- |
| `evmPrivateKey`  | string | Private key for Base/EVM payments (hex format)                            |
| `svmPrivateKey`  | string | Private key for Solana payments (base58 format)                           |
| `maxPaymentUSDC` | string | Maximum payment per request (e.g., "0.50")                                |
| `defaultNetwork` | string | Default network:`base`, `base-sepolia`, `solana`, `solana-devnet` |

## Tools

### x402_payment

Call x402-enabled paid APIs with automatic USDC payment.

```
Agent: I'll fetch the weather data for you.
[Calls x402_payment with url="https://weather.example.com/api/conditions?city=NYC"]
[Automatically pays $0.01 USDC, receives response]
Agent: The current temperature in NYC is 45°F with partly cloudy skies.
```

**Parameters:**

- `url` (required) - The x402-enabled endpoint URL
- `method` - HTTP method (default: GET)
- `params` - Query params (GET) or JSON body (POST/PUT/PATCH)
- `headers` - Custom headers
- `network` - Override network detection
- `maxPaymentUSDC` - Override max payment for this request

### x402_discover

Search the zauth directory for x402-enabled APIs.

```
Agent: Let me find weather APIs that accept x402 payments.
[Calls x402_discover with query="weather"]
Agent: I found 3 weather APIs - weather.example.com charges $0.01 per request...
```

**Parameters:**

- `query` - Search term (searches url, title, description)
- `network` - Filter by network: `base`, `solana`, etc.
- `verified` - Only show verified endpoints
- `limit` - Max results (default: 10, max: 50)

## Supported Networks

**EVM:**

- Base (mainnet)
- Base Sepolia (testnet)

**SVM:**

- Solana (mainnet)
- Solana Devnet
- Solana Testnet

## How x402 Works

1. Agent calls a paid endpoint
2. Server returns HTTP 402 with payment requirements
3. Extension signs and submits USDC payment
4. Extension retries request with payment proof
5. Server validates and returns the resource

All automatic - the agent just calls the API.

## Links

- [x402 Protocol](https://www.x402.org/)
- [zauth Directory](https://zauthx402.com)
- [OpenClaw Docs](https://docs.openclaw.ai)

## License

MIT
