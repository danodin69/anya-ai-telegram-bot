# CVEX Trading CLI

A command-line interface for interacting with the CVEX Trading API with AI-powered trading assistance.

## Features

- Configure and manage API credentials
- List available markets and contracts
- View market data (prices, orderbook, recent trades)
- Get detailed contract information
- View account details (portfolio, positions, orders)
- Interactive trading interface for both buying and selling
- Order estimation before placement
- Support for market and limit orders
- AI-powered natural language order creation
- AI market analysis with trading opportunity suggestions

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Make the CLI executable:
   ```
   chmod +x cvex
   ```
4. Install globally (optional):
   ```
   npm install -g .
   ```

You can then run the CLI using either `./cvex` or just `cvex` if installed globally.

## Configuration

Run the configuration command to set up your API credentials:

```
./cvex config
```

You'll need to provide:
- API URL (defaults to https://api.cvex.trade)
- API Key
- Path to your Ed25519 private key file (PEM format)
- OpenAI API Key (for AI features)

Configuration is stored in `~/.cvex-cli/config.json`.

## Usage

### List Available Markets

```
./cvex markets
```

### Get Contract Details

```
./cvex contract <contract_id>
```

### View Account Information

```
./cvex account
```

### Interactive Trading

```
./cvex trade
```

This will guide you through:
1. Selecting a contract
2. Choosing order side (buy or sell)
3. Setting order parameters (type, price, quantity, etc.)
4. Viewing order estimation
5. Confirming order placement

### AI-Powered Trading

#### Natural Language Order Creation

```
./cvex ai [your order in natural language]
```

Examples:
```
./cvex ai buy 0.01 BTCUSDT at market price
./cvex ai place a limit order to sell 0.05 ETH at 3500
```

The AI will interpret your natural language instructions and translate them into structured order parameters, showing you the interpretation and asking for confirmation before proceeding.

#### Market Analysis & Trading Suggestions

```
./cvex analyze
```

This command:
1. Collects market data for the most active contracts
2. Uses AI to analyze price trends, volatility, and market sentiment
3. Provides specific trading opportunities with entry prices, stop losses and take profits
4. Guides you through executing a suggested trade if you choose to proceed

## Trading Parameters

When placing an order, you'll be prompted for:

- **Order Side**: Buy or Sell
- **Order Type**: Market or Limit
- **Limit Price**: (for limit orders) The price at which you want to execute
- **Time in Force**: 
  - GTC (Good Till Cancel) - Order remains active until filled or cancelled
  - IOC (Immediate or Cancel) - Fill what's possible immediately, cancel the rest
  - FOK (Fill or Kill) - Fill the entire order immediately or cancel
  - PO (Post Only) - Order must be posted to the order book, not matched immediately
- **Reduce Only**: Yes/No - Whether the order should only reduce an existing position
- **Quantity**: The size of your order in steps

## Security Notes

- Your private key is only read from the file when needed to sign requests
- Never share your API key or private key
- API data and OpenAI API key are stored securely in your home directory
- All trading decisions suggested by AI still require your explicit confirmation
- Consider adding additional validation for production use

## API Documentation

For more details on the CVEX API, refer to their official API documentation.