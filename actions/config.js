// config.js - Configuration actions
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.cvex-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Default config
let config = {
  apiUrl: 'https://api.cvex.trade',
  apiKey: '',
  privateKeyPath: ''
};

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = { ...config, ...JSON.parse(configData) };
      return true;
    }
  } catch (error) {
    console.error('Error loading config:', error.message);
  }
  return false;
}

// Save configuration
function saveConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Configuration saved to ${CONFIG_FILE}`);
  } catch (error) {
    console.error('Error saving config:', error.message);
  }
}

// Get current configuration
function getConfig() {
  return config;
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  CONFIG_FILE
};