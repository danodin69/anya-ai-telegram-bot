# CVEX Trading CLI

A command-line interface for interacting with the CVEX Trading API.

## Features

- Configure and manage API credentials
- List available markets and contracts
- View market data (prices, orderbook, recent trades)
- Get detailed contract information
- View account details (portfolio, positions, orders)
- Interactive trading interface
- Order estimation before placement

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Make the CLI executable:
   ```
   chmod +x cvex-cli.js
   ```
4. Install globally (optional):
   ```
   npm install -g .
   ```

## Configuration

Run the configuration command to set up your API credentials:

```
./cvex-cli.js config
```

You'll need to provide:
- API URL (defaults to https://api.cvex.trade)
- API Key
- Path to your Ed25519 private key file (PEM format)

Configuration is stored in `~/.cvex-cli/config.json`.

## Usage

### List Available Markets

```
./cvex-cli.js markets
```

### Get Contract Details

```
./cvex-cli.js contract <contract_id>
```

### View Account Information

```
./cvex-cli.js account
```

### Interactive Trading

```
./cvex-cli.js trade
```

This will guide you through:
1. Selecting a contract
2. Setting order parameters
3. Viewing order estimation
4. Confirming order placement

## Security Notes

- Your private key is only read from the file when needed to sign requests
- Never share your API key or private key
- Consider adding additional validation for production use

## API Documentation

For more details on the CVEX API, refer to their official API documentation.