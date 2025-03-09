#!/usr/bin/env node
// cvex-cli.js - Main entry point for the CVEX CLI
const readline = require('readline');
const { program } = require('commander');

// Import actions
const { loadConfig, saveConfig, getConfig } = require('./actions/config');
const { listContracts, getContractDetails, getMarketData, selectContract } = require('./actions/markets');
const { estimateOrder, placeOrder } = require('./actions/trading');
const { getAccountInformation } = require('./actions/account');

// Initialize CLI
program
  .name('cvex-cli')
  .description('CVEX Trading API CLI Tool')
  .version('1.0.0');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Utility to ask questions
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Configure command
program
  .command('config')
  .description('Configure API credentials')
  .action(async () => {
    try {
      loadConfig();
      const config = getConfig();
      
      console.log('CVEX API Configuration');
      console.log('-'.repeat(30));
      
      const apiUrl = await question(`API URL [${config.apiUrl}]: `);
      if (apiUrl) config.apiUrl = apiUrl;
      
      const apiKey = await question(`API Key [${config.apiKey ? '********' : ''}]: `);
      if (apiKey) config.apiKey = apiKey;
      
      const privateKeyPath = await question(`Private Key File Path [${config.privateKeyPath || ''}]: `);
      if (privateKeyPath) config.privateKeyPath = privateKeyPath;
      
      saveConfig();
    } finally {
      rl.close();
    }
  });

// Show current config
program
  .command('show-config')
  .description('Display current configuration')
  .action(() => {
    try {
      if (!loadConfig()) {
        console.log('No configuration found. Please run "cvex-cli config" to set up.');
        return;
      }
      
      const config = getConfig();
      console.log('Current Configuration:');
      console.log('-'.repeat(30));
      console.log(`API URL:              ${config.apiUrl}`);
      console.log(`API Key:              ${config.apiKey ? '********' : 'Not set'}`);
      console.log(`Private Key Path:     ${config.privateKeyPath || 'Not set'}`);
      console.log('-'.repeat(30));
    } finally {
      rl.close();
    }
  });

// Markets command
program
  .command('markets')
  .description('List available markets/contracts')
  .action(async () => {
    try {
      if (!loadConfig()) {
        console.log('Please run "cvex-cli config" first to set up your API credentials.');
        return;
      }
      
      await listContracts();
    } finally {
      rl.close();
    }
  });

// Contract detail command
program
  .command('contract <id>')
  .description('Get details for a specific contract')
  .action(async (id) => {
    try {
      if (!loadConfig()) {
        console.log('Please run "cvex-cli config" first to set up your API credentials.');
        return;
      }
      
      await getContractDetails(id);
      await getMarketData(id);
    } finally {
      rl.close();
    }
  });

// Account command
program
  .command('account')
  .description('Get account information')
  .action(async () => {
    try {
      if (!loadConfig()) {
        console.log('Please run "cvex-cli config" first to set up your API credentials.');
        return;
      }
      
      await getAccountInformation();
    } finally {
      rl.close();
    }
  });

// Trading command
program
  .command('trade')
  .description('Interactive trading interface')
  .action(async () => {
    try {
      if (!loadConfig()) {
        console.log('Please run "cvex-cli config" first to set up your API credentials.');
        return;
      }
      
      console.log('CVEX Trading Interface');
      console.log('======================');
      
      // First, get account info
      await getAccountInformation();
      
      // Then, select a contract
      const contract = await selectContract(question);
      if (!contract) {
        console.log('Trading session cancelled.');
        return;
      }
      
      // Get order parameters and estimate
      const orderData = await estimateOrder(contract, question);
      if (!orderData) {
        console.log('Order estimation failed or cancelled.');
        return;
      }
      
      // Place the order if confirmed
      await placeOrder(orderData, question);
    } finally {
      rl.close();
    }
  });

// Main execution
if (require.main === module) {
  program.parse(process.argv);
  
  // Display help if no args
  if (process.argv.length <= 2) {
    program.help();
  }
}

module.exports = {
  listContracts,
  getContractDetails,
  getMarketData,
  getAccountInformation,
  estimateOrder,
  placeOrder
};