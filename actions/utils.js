// utils.js - Utility functions
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const { getConfig } = require('./config');

/**
 * Extracts the API key from the private key by processing the DER public key.
 * @param {Object} privateKey - The private key object.
 * @returns {string} - The extracted API key in hexadecimal format.
 */
function getApiKey(privateKey) {
  const derPublicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const rawPublicKey = derPublicKey.subarray(-32); // Extract the last 32 bytes (raw key)
  return rawPublicKey.toString('hex');
}

/**
 * Constructs the message to be signed by combining HTTP method, URL, and body.
 * @param {string} method - The HTTP method (e.g., POST).
 * @param {string} url - The request URL.
 * @param {string} body - The request body.
 * @returns {string} - The message to be signed.
 */
function getMessageForSigning(method, url, body) {
  return `${method} ${url}\n${body}`;
}

/**
 * Signs a message using the provided private key.
 * @param {Object} privateKey - The private key object.
 * @param {string} method - HTTP method.
 * @param {string} url - The request URL.
 * @param {string} body - The request body as JSON string.
 * @returns {string} - The generated signature in hexadecimal format.
 */
function signMessage(privateKey, method, url, body) {
  try {
    console.log(`Signing message with method: ${method}, URL: ${url}`);
    console.log(`Message body: ${body}`);
    
    // Create the message to sign according to canonical implementation
    const messageForSigning = getMessageForSigning(method, url, body);
    console.log(`Message for signing: ${messageForSigning}`);
    
    // Create a hash of the message
    const hash = crypto.createHash('sha256').update(messageForSigning).digest();
    
    // Sign the hash with private key
    const signature = crypto.sign(null, hash, privateKey);
    
    // Convert signature to hex
    const signatureHex = signature.toString('hex');
    console.log(`Generated signature: ${signatureHex}`);
    
    return signatureHex;
  } catch (error) {
    console.error('Error signing message (detailed):', error);
    throw error;
  }
}

// API request helper
async function apiRequest(method, endpoint, data = null, needsSignature = false) {
  try {
    const config = getConfig();
    const url = `${config.apiUrl}${endpoint}`;
    
    let headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'CVEX-CLI/1.0'
    };

    if (needsSignature) {
      if (!config.privateKeyPath || !fs.existsSync(config.privateKeyPath)) {
        throw new Error('Private key not configured or file not found');
      }

      const privateKeyPEM = fs.readFileSync(config.privateKeyPath, 'utf8');
      
      // Create private key object
      const privateKey = crypto.createPrivateKey({
        key: privateKeyPEM,
        format: 'pem',
        type: 'pkcs8',
      });
      
      // Extract API key from private key
      const apiKey = getApiKey(privateKey);
      console.log('Extracted API key:', apiKey);
      headers['X-API-KEY'] = apiKey;
      
      // For trading endpoints that require signatures
      const messageToSign = JSON.stringify(data);
      console.log('Message to sign:', messageToSign);
      
      // Generate signature
      const signature = signMessage(privateKey, method, url, messageToSign);
      headers['X-Signature'] = signature;
    } else {
      // For non-signature requests, use API key from config
      headers['X-API-KEY'] = config.apiKey;
    }

    const response = await axios({
      method,
      url,
      headers,
      data: data || undefined
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(`API Error (${error.response.status}):`, error.response.data);
    } else {
      console.error('Request Error:', error.message);
    }
    throw error;
  }
}

// Format numbers for display
function formatNumber(num) {
  return parseFloat(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
}

// Display table helper
function displayTable(headers, data) {
  // Calculate column widths
  const widths = headers.map((header, index) => {
    const maxDataLength = data.reduce((max, row) => {
      const cell = String(row[index] || '');
      return cell.length > max ? cell.length : max;
    }, 0);
    return Math.max(header.length, maxDataLength) + 2;
  });

  // Print headers
  console.log(
    headers.map((header, i) => header.padEnd(widths[i])).join(' | ')
  );
  console.log(
    headers.map((_, i) => '-'.repeat(widths[i])).join('-+-')
  );

  // Print data
  data.forEach(row => {
    console.log(
      row.map((cell, i) => String(cell || '').padEnd(widths[i])).join(' | ')
    );
  });
}

module.exports = {
  signMessage,
  apiRequest,
  formatNumber,
  displayTable,
  getApiKey,
  getMessageForSigning
};