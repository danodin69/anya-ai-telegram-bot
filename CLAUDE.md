# CVEX Trusted Mode Trading CLI Guidelines

## Commands
- Start CLI: `node cvex-cli.js` or `./cvex-cli.js`
- Run specific command: `./cvex-cli.js [command]` (markets, contract, account, trade, config)
- Install dependencies: `npm install`
- Make executable: `chmod +x cvex-cli.js`
- Install globally: `npm install -g .`
- Test signature: `node signature-test.js`

## Code Style
- **Format**: No specific linter/formatter configured; follow existing style (2-space indentation)
- **Error handling**: Use try/catch blocks with specific error messages
- **Naming**: camelCase for variables/functions, UPPER_CASE for constants
- **Imports**: CommonJS style (`require()`) over ES modules
- **Function style**: Async/await pattern for API requests
- **Typing**: JavaScript without TypeScript; use JSDoc comments for important functions
- **Modular**: Code organized by function in `/actions` directory

## API Pattern
- API requests use axios with standardized headers
- Signed requests include X-Signature header with SHA-256 hash signature
- Use apiRequest helper function for all API calls
- Always handle API errors with specific error messages

## Security
- Private keys stored as files, only read when needed for signing
- Configuration saved in user's home directory (~/.cvex-cli/config.json)
- Never log or expose private keys or full signatures
- API keys are derived from private keys using DER extraction