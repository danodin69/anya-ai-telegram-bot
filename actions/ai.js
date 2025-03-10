// ai.js - AI-assisted order creation actions
const { OpenAI } = require('openai');
const { apiRequest, formatNumber, displayTable } = require('./utils');
const { listContracts, getContractDetails, getMarketData } = require('./markets');
const { estimateOrder, placeOrder } = require('./trading');
const { getConfig } = require('./config');
const { getAccountInformation } = require('./account');

// Initialize OpenAI client when needed
function getOpenAIClient() {
  const config = getConfig();
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured. Please run "cvex config" to set it up.');
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}

// Convert natural language to structured order
async function parseNaturalLanguageOrder(input, contracts) {
  try {
    const openai = getOpenAIClient();
    
    // Prepare contract information for the AI
    const contractsInfo = contracts.map(c => 
      `${c.contract_id}: ${c.symbol} (Index: ${c.index})`
    ).join('\n');
    
    // Create system prompt with information about available contracts
    const prompt = [
      {
        role: "system",
        content: `You are a trading assistant that parses natural language requests into structured order parameters. 
        Available contracts:\n${contractsInfo}
        
        Extract these parameters from the user's input:
        1. contract: Symbol or ID of the contract to trade
        2. orderSide: "buy" or "sell"
        3. orderType: "market" or "limit"
        4. quantity: The amount to trade in contracts (decimal)
        5. limitPrice: If orderType is "limit", the limit price (omit for market orders)
        6. timeInForce: "GTC" (Good Till Cancel), "IOC" (Immediate or Cancel), "FOK" (Fill or Kill), or "PO" (Post Only)
        7. reduceOnly: true or false
        
        For missing parameters, use these defaults:
        - orderType: "market"
        - timeInForce: "GTC"
        - reduceOnly: false
        
        Return a JSON object with all fields. For any fields you can't confidently determine, set to null.`
      },
      {
        role: "user",
        content: input
      }
    ];

    // Call OpenAI API to parse the input
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Use GPT-3.5 for faster, cheaper responses
      messages: prompt,
      response_format: { type: "json_object" }
    });

    // Parse the response
    const parsedOrder = JSON.parse(response.choices[0].message.content);
    console.log('AI parsed order parameters:', parsedOrder);
    
    // Resolve contract ID or symbol
    if (parsedOrder.contract) {
      // Check if input is a symbol
      if (isNaN(parsedOrder.contract)) {
        const matchedContract = contracts.find(c => 
          c.symbol.toLowerCase() === parsedOrder.contract.toLowerCase() ||
          c.index.toLowerCase() === parsedOrder.contract.toLowerCase()
        );
        
        if (matchedContract) {
          parsedOrder.contractId = matchedContract.contract_id;
          parsedOrder.symbol = matchedContract.symbol;
          console.log(`Resolved '${parsedOrder.contract}' to contract ID: ${parsedOrder.contractId}`);
        } else {
          throw new Error(`Could not find a matching contract for: ${parsedOrder.contract}`);
        }
      } else {
        // It's already a contract ID
        parsedOrder.contractId = parseInt(parsedOrder.contract);
        const matchedContract = contracts.find(c => c.contract_id === parsedOrder.contractId);
        if (matchedContract) {
          parsedOrder.symbol = matchedContract.symbol;
        }
      }
    }
    
    return parsedOrder;
  } catch (error) {
    console.error('Error parsing natural language order:', error.message);
    throw error;
  }
}

// Process natural language order
async function processNaturalLanguageOrder(input, question) {
  try {
    console.log(`\nProcessing natural language request: "${input}"`);
    
    // Get available contracts
    console.log('\nFetching available contracts...');
    const contracts = await listContracts();
    if (!contracts || contracts.length === 0) {
      console.log('No contracts available. Please try again later.');
      return;
    }
    
    // Parse the natural language input
    let parsedOrder;
    try {
      parsedOrder = await parseNaturalLanguageOrder(input, contracts);
    } catch (error) {
      console.log(`Error: ${error.message}`);
      return;
    }
    
    // Validate the parsed order parameters
    if (!parsedOrder || !parsedOrder.contractId) {
      console.log('Could not understand the contract you want to trade.');
      console.log('Available contracts:');
      contracts.forEach(c => console.log(`- ${c.symbol} (${c.index})`));
      return;
    }
    
    if (!parsedOrder.orderSide) {
      const side = await question('Would you like to buy or sell? ');
      parsedOrder.orderSide = side.toLowerCase();
    }
    
    if (!parsedOrder.quantity) {
      const quantity = await question('Please specify the quantity (in contracts): ');
      parsedOrder.quantity = quantity.trim();
    }
    
    // Set defaults for missing parameters
    if (!parsedOrder.orderType) parsedOrder.orderType = 'market';
    if (!parsedOrder.timeInForce) parsedOrder.timeInForce = 'GTC';
    if (parsedOrder.reduceOnly === null || parsedOrder.reduceOnly === undefined) parsedOrder.reduceOnly = false;
    
    // For limit orders, ensure we have a limit price
    if (parsedOrder.orderType === 'limit' && !parsedOrder.limitPrice) {
      const price = await question('Please specify the limit price: ');
      parsedOrder.limitPrice = price.trim();
    }
    
    // Get contract details
    const contract = await getContractDetails(parsedOrder.contractId);
    if (!contract) {
      console.log(`Contract with ID ${parsedOrder.contractId} not found.`);
      return;
    }
    
    // Get min order size from contract details
    const minOrderSize = parseFloat(contract.min_order_size_contracts || "0.001");
    
    // Ensure quantity is at least minimum order size
    const quantityNum = parseFloat(parsedOrder.quantity);
    if (isNaN(quantityNum) || quantityNum < minOrderSize) {
      console.log(`Note: Minimum order size for ${contract.symbol} is ${minOrderSize} contracts.`);
      parsedOrder.quantity = minOrderSize.toString();
    }
    
    // Create order parameters for estimation
    const orderParams = {
      contract: parsedOrder.contractId.toString(),
      type: parsedOrder.orderType,
      limit_price: parsedOrder.orderType === 'limit' ? parsedOrder.limitPrice : '0',
      time_in_force: parsedOrder.timeInForce,
      reduce_only: parsedOrder.reduceOnly
    };
    
    // Add the quantity as contracts (this is what the API expects)
    if (parsedOrder.orderSide.toLowerCase() === 'buy') {
      orderParams.quantity_contracts = parsedOrder.quantity.toString();
    } else {
      orderParams.quantity_contracts = `-${parsedOrder.quantity}`;
    }
    
    // Show the interpreted order and ask for confirmation
    console.log('\nInterpreted Order Parameters:');
    console.log('-'.repeat(50));
    console.log(`Contract:    ${contract.symbol} (ID: ${contract.contract_id})`);
    console.log(`Order Side:  ${parsedOrder.orderSide.toUpperCase()}`);
    console.log(`Order Type:  ${parsedOrder.orderType.toUpperCase()}`);
    if (parsedOrder.orderType === 'limit') {
      console.log(`Limit Price: ${parsedOrder.limitPrice}`);
    }
    console.log(`Quantity:    ${parsedOrder.quantity} contracts`);
    console.log(`Time in Force: ${parsedOrder.timeInForce}`);
    console.log(`Reduce Only: ${parsedOrder.reduceOnly}`);
    console.log('-'.repeat(50));
    
    // Ask if the interpretation is correct
    const confirmInterpretation = await question('\nIs this interpretation correct? (yes/no): ');
    if (confirmInterpretation.toLowerCase() !== 'yes' && confirmInterpretation.toLowerCase() !== 'y') {
      console.log('Order cancelled. Please try again with clearer instructions.');
      return;
    }
    
    // Estimate the order
    console.log('\nEstimating order...');
    try {
      const estimationResult = await apiRequest('POST', '/v1/trading/estimate-order', orderParams);
      
      if (estimationResult) {
        console.log('\nOrder Estimation Result:');
        console.log('-'.repeat(50));
        
        if (estimationResult.error) {
          console.log(`Error: ${estimationResult.error}`);
          return;
        }
        
        console.log(`Order Type:                 ${parsedOrder.orderSide.toUpperCase()} ${parsedOrder.orderType}`);
        console.log(`Trading Fee:                ${formatNumber(estimationResult.trading_fee)}`);
        console.log(`Operational Fee:            ${formatNumber(estimationResult.operational_fee)}`);
        console.log(`Realized Profit:            ${formatNumber(estimationResult.realized_profit)}`);
        console.log(`Taker Amount (Base):        ${formatNumber(estimationResult.taker_base_amount)}`);
        console.log(`Taker Amount (Tokens):      ${formatNumber(estimationResult.taker_tokens_amount)}`);
        console.log(`Current Equity:             ${formatNumber(estimationResult.current_equity)}`);
        console.log(`New Equity:                 ${formatNumber(estimationResult.new_equity)}`);
        console.log(`Current Leverage:           ${formatNumber(estimationResult.current_leverage)}`);
        console.log(`New Leverage:               ${formatNumber(estimationResult.new_leverage)}`);
        console.log(`Est. Liquidation Price:     ${formatNumber(estimationResult.estimated_liquidation_price)}`);
        console.log('-'.repeat(50));
        
        // Create order data for placement
        const orderData = {
          estimationResult,
          orderParams: {
            customer_order_id: `cli-${Date.now()}`,
            contract: orderParams.contract,
            type: orderParams.type,
            limit_price: orderParams.limit_price,
            time_in_force: orderParams.time_in_force,
            reduce_only: orderParams.reduce_only,
            quantity_contracts: orderParams.quantity_contracts,
            timestamp: Date.now(),
            recv_window: 30000
          }
        };
        
        // Place the order
        await placeOrder(orderData, question);
      }
    } catch (error) {
      console.error('Error estimating order:', error.message);
    }
  } catch (error) {
    console.error('Error processing natural language order:', error.message);
  }
}

// Analyze market data and propose trading opportunities
async function analyzeMarketOpportunities(question) {
  try {
    console.log('\nAI Market Analysis Starting...');
    console.log('-'.repeat(60));
    
    // Step 1: Get account information for context
    console.log('Fetching account information...');
    await getAccountInformation();
    
    // Step 2: Get all available contracts
    console.log('\nFetching available contracts...');
    const contracts = await listContracts();
    if (!contracts || contracts.length === 0) {
      console.log('No contracts available. Please try again later.');
      return;
    }

    // Debug: Check contract structure
    // console.log("Contract data structure:", JSON.stringify(contracts[0], null, 2));
    
    // Step 3: Gather market data for analysis
    console.log('\nGathering market data for analysis...');
    
    // Sort the contracts by some criteria - prefer volume if available, otherwise by ID
    let contractsToAnalyze = [];
    try {
      contractsToAnalyze = [...contracts]
        .sort((a, b) => {
          // First try to sort by volume
          try {
            const volumeA = a && a.volume_24h ? parseFloat(a.volume_24h) : 0;
            const volumeB = b && b.volume_24h ? parseFloat(b.volume_24h) : 0;
            return volumeB - volumeA;
          } catch (err) {
            // If there's any error in parsing, fall back to sorting by ID
            return (b.contract_id || 0) - (a.contract_id || 0);
          }
        })
        .slice(0, 3);
    } catch (error) {
      console.log(`Warning: Error sorting contracts: ${error.message}`);
      // Just take the first 3 contracts if sorting fails
      contractsToAnalyze = contracts.slice(0, 3);
    }
    
    const marketData = [];
    
    // Collect detailed data for each contract
    for (const contract of contractsToAnalyze) {
      try {
        console.log(`Analyzing ${contract.symbol}...`);
        
        // Get contract details
        const details = await getContractDetails(contract.contract_id);
        
        // Get price history
        let priceHistory = { data: [] };
        try {
          priceHistory = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/price?period=1h&count=24`);
        } catch (error) {
          console.log(`Warning: Could not fetch price history for ${contract.symbol}: ${error.message}`);
        }
        
        // Get order book with valid price step based on the contract symbol/type
        let priceStep;
        
        // Determine price step based on the contract symbol
        if (contract.symbol.includes('BTC')) {
          priceStep = '5'; // BTC valid steps: 5, 50, 500, 2500, 5000
        } else if (contract.symbol.includes('ETH')) {
          priceStep = '1'; // ETH valid steps: 1, 10, 100, 500, 1000 
        } else if (contract.symbol.includes('SOL')) {
          priceStep = '0.1'; // SOL valid steps: 0.1, 1, 10, 50, 100
        } else if (contract.symbol.includes('XRP')) {
          priceStep = '0.001'; // Assumption for XRP
        } else {
          // Default for other assets
          priceStep = '0.1';
        }
        
        let orderBook = { bids: [], asks: [] };
        try {
          orderBook = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/order-book?price_step=${priceStep}`);
        } catch (error) {
          console.log(`Warning: Could not fetch order book for ${contract.symbol}: ${error.message}`);
        }
        
        // Get recent trades
        let recentTrades = { trades: [] };
        try {
          recentTrades = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/latest-trades?count=20`);
        } catch (error) {
          console.log(`Warning: Could not fetch recent trades for ${contract.symbol}: ${error.message}`);
        }
        
        marketData.push({
          contract_id: contract.contract_id,
          symbol: contract.symbol,
          details,
          priceHistory: priceHistory.data || [],
          orderBook: orderBook || { bids: [], asks: [] },
          recentTrades: recentTrades.trades || []
        });
      } catch (error) {
        console.log(`Error analyzing ${contract.symbol}: ${error.message}`);
        // Continue with the next contract
        continue;
      }
    }
    
    // Step 4: Use AI to analyze the market data and suggest opportunities
    if (marketData.length === 0) {
      console.log('\nNo market data available for analysis. Please try again later.');
      
      // If we have contracts but couldn't get market data, still show what we have
      if (contracts && contracts.length > 0) {
        console.log(`Note: Found ${contracts.length} contracts but could not gather detailed market data.`);
        console.log('Try analyzing a specific contract manually with: cvex contract <id>');
      }
      
      return;
    }
    
    console.log('\nAnalyzing market data with AI...');
    const openai = getOpenAIClient();
    
    // Prepare market data for AI analysis
    const marketSummary = marketData.map(market => {
      try {
        // Calculate basic metrics from price history (if available)
        let prices = [];
        try {
          prices = (market.priceHistory || []).map(p => parseFloat(p.price_close)).filter(p => !isNaN(p));
        } catch (err) {
          console.log(`Warning: Error processing price history for ${market.symbol || 'unknown contract'}`);
          prices = [];
        }
        
        const latestPrice = prices.length > 0 ? prices[prices.length - 1] : 
                           (market.details?.last_price ? parseFloat(market.details.last_price) : 0);
        const priceChange24h = prices.length > 0 && prices[0] !== 0 ? 
                              ((latestPrice - prices[0]) / prices[0] * 100) : 0;
        
        // Calculate volume - carefully handle all possible structures
        let volume24h = 0;
        
        // Try multiple paths to find volume data
        if (market.details && market.details.volume_24h !== undefined) {
          try {
            volume24h = parseFloat(market.details.volume_24h);
          } catch (e) {
            volume24h = 0;
          }
        } else if (market.contract_id && contracts) {
          // Look up the original contract object
          try {
            const contractObject = contracts.find(c => c.contract_id === market.contract_id);
            if (contractObject && contractObject.volume_24h !== undefined) {
              volume24h = parseFloat(contractObject.volume_24h);
            }
          } catch (e) {
            volume24h = 0;
          }
        }
      
        // Calculate bid-ask spread - safely handle undefined or empty objects
        let topBid = 0, topAsk = 0, spread = 0;
        try {
          if (market.orderBook && market.orderBook.bids && market.orderBook.bids.length > 0) {
            topBid = parseFloat(market.orderBook.bids[0].price) || 0;
          }
          
          if (market.orderBook && market.orderBook.asks && market.orderBook.asks.length > 0) {
            topAsk = parseFloat(market.orderBook.asks[0].price) || 0;
          }
          
          spread = (topAsk > 0 && topBid > 0) ? ((topAsk - topBid) / topAsk * 100) : 0;
        } catch (e) {
          console.log(`Warning: Error calculating spread for ${market.symbol || 'unknown contract'}`);
        }
      
        // Analyze recent trade direction - safely handle missing data
        let recentTradesSell = 0, recentTradesBuy = 0, buyPressure = 50;
        try {
          if (market.recentTrades && Array.isArray(market.recentTrades)) {
            recentTradesSell = market.recentTrades.filter(t => t && t.taker_side === 'sell').length;
            recentTradesBuy = market.recentTrades.filter(t => t && t.taker_side === 'buy').length;
            
            if (market.recentTrades.length > 0) {
              buyPressure = (recentTradesBuy / market.recentTrades.length) * 100;
            }
          }
        } catch (e) {
          console.log(`Warning: Error analyzing trade direction for ${market.symbol || 'unknown contract'}`);
        }
        
        // Build the summary object with safe fallbacks for all values
        return {
          symbol: market.symbol || 'Unknown',
          contract_id: market.contract_id || 0,
          mark_price: market.details?.mark_price || 0,
          last_price: market.details?.last_price || 0,
          index_price: market.details?.index_price || 0,
          price_change_24h: (priceChange24h || 0).toFixed(2) + '%',
          volume_24h: volume24h || 0,
          open_interest: market.details?.open_interest || 0,
          bid_ask_spread: (spread || 0).toFixed(2) + '%',
          top_bid: topBid || 0,
          top_ask: topAsk || 0,
          buy_sell_ratio: `${(buyPressure || 0).toFixed(0)}% buy / ${(100 - (buyPressure || 0)).toFixed(0)}% sell`,
          volatility: calculateVolatility(prices) || 'Unknown',
          price_trend: analyzePriceTrend(prices) || 'Unknown'
        };
      } catch (error) {
        // If any contract analysis fails, return a minimal object with available data
        console.log(`Warning: Error creating market summary for ${market.symbol || 'unknown contract'}: ${error.message}`);
        return {
          symbol: market.symbol || 'Unknown',
          contract_id: market.contract_id || 0,
          mark_price: market.details?.mark_price || 0,
          last_price: market.details?.last_price || 0,
          index_price: market.details?.index_price || 0,
          price_change_24h: '0.00%',
          volume_24h: 0,
          open_interest: 0,
          bid_ask_spread: '0.00%',
          top_bid: 0,
          top_ask: 0,
          buy_sell_ratio: '50% buy / 50% sell',
          volatility: 'Unknown',
          price_trend: 'Unknown'
        };
      }
    });
    
    // Use AI to analyze the data and suggest trading opportunities
    const prompt = [
      {
        role: "system",
        content: `You are a professional crypto trading analyst. Analyze the market data for different futures contracts and suggest trading opportunities.

For each contract, consider:
1. Price trends and momentum
2. Volatility
3. Buy/sell pressure
4. Bid-ask spreads
5. Price deviations from index
6. Volume patterns

Provide 1-3 specific trading opportunities with:
1. Contract symbol
2. Action (buy/sell)
3. Entry price recommendation
4. Suggested stop loss
5. Suggested take profit
6. Position size recommendation (small/medium/large - as % of account)
7. Brief rationale (max 2 sentences)
8. Risk level (low/medium/high)

Number each opportunity clearly (e.g., "Opportunity 1:", "Opportunity 2:").
Be specific, practical and concise. Focus on actionable trades.`
      },
      {
        role: "user",
        content: `Here is the market data for analysis:\n${JSON.stringify(marketSummary, null, 2)}`
      }
    ];

    // Get AI analysis
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // Using GPT-4o for better market analysis
      messages: prompt,
      temperature: 0.7
    });

    // Display AI analysis
    console.log('\nAI Market Analysis Results:');
    console.log('-'.repeat(60));
    console.log(response.choices[0].message.content);
    console.log('-'.repeat(60));
    
    // Step 5: Ask user if they want to act on any of the opportunities
    const wantToTrade = await question('\nWould you like to act on any of these opportunities? (yes/no): ');
    if (wantToTrade.toLowerCase() !== 'yes' && wantToTrade.toLowerCase() !== 'y') {
      console.log('No action taken.');
      return;
    }
    
    // Step 6: Let user select which opportunity to trade
    const opportunityNumber = await question('\nEnter the number of the opportunity you want to trade (1, 2, 3...): ');
    
    // Parse the AI response to extract the opportunity details
    console.log('\nParsing AI recommendation...');
    
    // Declare orderParams at a higher scope so it's available outside the try block
    let orderParams = null;
    let orderSide = null;
    let isMarket = true;
    
    try {
      // Extract the opportunity details from the AI response
      const aiResponseContent = response.choices[0].message.content;
      const opportunities = parseOpportunitiesFromAIResponse(aiResponseContent);
      
      // Validate opportunity number
      const oppNumber = parseInt(opportunityNumber);
      if (isNaN(oppNumber) || oppNumber < 1 || oppNumber > opportunities.length) {
        console.log(`Invalid opportunity number. Please select a number between 1 and ${opportunities.length}.`);
        return;
      }
      
      // Get the selected opportunity
      const selectedOpp = opportunities[oppNumber - 1];
      console.log('\nSelected opportunity:');
      console.log('-'.repeat(60));
      console.log(`Contract: ${selectedOpp.symbol}`);
      console.log(`Action: ${selectedOpp.action}`);
      console.log(`Entry Price: ${selectedOpp.entryPrice}`);
      console.log(`Stop Loss: ${selectedOpp.stopLoss}`);
      console.log(`Take Profit: ${selectedOpp.takeProfit}`);
      console.log(`Position Size: ${selectedOpp.positionSize}`);
      console.log(`Risk Level: ${selectedOpp.riskLevel}`);
      console.log(`Rationale: ${selectedOpp.rationale}`);
      console.log('-'.repeat(60));
      
      // Find the contract in the list
      let selectedContract = contracts.find(c => c.symbol.toLowerCase() === selectedOpp.symbol.toLowerCase());
      if (!selectedContract) {
        // If exact match not found, try partial match
        const possibleContract = contracts.find(c => 
          selectedOpp.symbol.toLowerCase().includes(c.symbol.toLowerCase()) || 
          c.symbol.toLowerCase().includes(selectedOpp.symbol.toLowerCase())
        );
        
        if (possibleContract) {
          console.log(`Exact match not found for ${selectedOpp.symbol}. Using ${possibleContract.symbol} instead.`);
          selectedOpp.symbol = possibleContract.symbol;
          selectedContract = possibleContract;
        } else {
          // If still not found, ask user to specify
          const symbolInput = await question(`Contract ${selectedOpp.symbol} not found. Please enter a valid contract symbol: `);
          const userSelectedContract = contracts.find(c => c.symbol.toLowerCase() === symbolInput.toLowerCase());
          if (!userSelectedContract) {
            console.log('Invalid contract symbol. Aborting.');
            return;
          }
          selectedContract = userSelectedContract;
          selectedOpp.symbol = symbolInput;
        }
      }
      
      // Get contract details
      const contractDetails = await getContractDetails(selectedContract.contract_id);
      if (!contractDetails) {
        console.log(`Could not get details for contract ${selectedOpp.symbol}.`);
        return;
      }
      
      // Step 7: Auto-craft order parameters based on AI suggestion and ask for confirmation
      console.log(`\nCrafting order for ${selectedContract.symbol} based on AI recommendation...`);
      
      // Set order side based on the recommendation
      const orderSide = selectedOpp.action.toLowerCase();
      if (orderSide !== 'buy' && orderSide !== 'sell') {
        console.log(`Invalid action "${selectedOpp.action}". Expected "buy" or "sell".`);
        return;
      }
      
      // Determine if it's a market or limit order
      // If entry price is close to current market price, suggest market order
      // Otherwise, suggest limit order
      const currentPrice = parseFloat(contractDetails.mark_price) || parseFloat(contractDetails.last_price) || 0;
      const entryPrice = parseFloat(selectedOpp.entryPrice.replace(/[^\d.-]/g, '')) || currentPrice;
      
      // Calculate price difference as percentage
      const priceDiffPercent = Math.abs((entryPrice - currentPrice) / currentPrice * 100);
      
      // Suggest market or limit based on how close the entry price is to current price
      let isMarket = priceDiffPercent < 1.0; // If within 1% of current price, suggest market order
      let limitPrice = entryPrice.toString();
      
      // For position size, parse the recommendation and convert to contracts
      // Assume "small" is 1% of account, "medium" is 5%, "large" is 10%
      const portfolioResponse = await apiRequest('GET', '/v1/portfolio/overview');
      const equity = portfolioResponse?.portfolio?.equity ? parseFloat(portfolioResponse.portfolio.equity) : 10; // Default if not available
      
      let positionSizePercent = 0.01; // Default to 1%
      if (selectedOpp.positionSize.toLowerCase().includes('medium')) {
        positionSizePercent = 0.05; // 5%
      } else if (selectedOpp.positionSize.toLowerCase().includes('large')) {
        positionSizePercent = 0.10; // 10%
      }
      
      // Calculate position size in USD
      const positionSizeUSD = equity * positionSizePercent;
      
      // Convert to contracts based on entry price
      let quantity = 0;
      if (entryPrice > 0) {
        // Calculate based on contractDetails.contract_size and min_order_size_contracts
        const minOrderSize = parseFloat(contractDetails.min_order_size_contracts || "0.001");
        quantity = Math.max(minOrderSize, (positionSizeUSD / entryPrice).toFixed(3));
      } else {
        quantity = contractDetails.min_order_size_contracts || "0.001";
      }
      
      // Show suggested order and ask for confirmation/modification
      console.log('\nSuggested Order Parameters:');
      console.log('-'.repeat(60));
      console.log(`Contract: ${selectedContract.symbol} (ID: ${selectedContract.contract_id})`);
      console.log(`Order Side: ${orderSide.toUpperCase()}`);
      console.log(`Order Type: ${isMarket ? 'MARKET' : 'LIMIT'}`);
      if (!isMarket) {
        console.log(`Limit Price: ${limitPrice}`);
      }
      console.log(`Quantity: ${quantity} contracts`);
      console.log(`Time in Force: GTC`);
      console.log(`Reduce Only: false`);
      console.log('-'.repeat(60));
      
      // Ask if the user would like to modify any parameters
      const modifyParams = await question('\nWould you like to modify any parameters? (yes/no): ');
      
      if (modifyParams.toLowerCase() === 'yes' || modifyParams.toLowerCase() === 'y') {
        // Allow modification of order type
        const marketOrLimit = await question(`Order type (market/limit) [${isMarket ? 'market' : 'limit'}]: `);
        if (marketOrLimit.trim()) {
          isMarket = marketOrLimit.toLowerCase() === 'market';
        }
        
        // For limit orders, allow modification of limit price
        if (!isMarket) {
          const newLimitPrice = await question(`Limit price [${limitPrice}]: `);
          if (newLimitPrice.trim()) {
            limitPrice = newLimitPrice;
          }
        }
        
        // Allow modification of quantity
        const newQuantity = await question(`Quantity in contracts [${quantity}]: `);
        if (newQuantity.trim()) {
          quantity = newQuantity;
        }
      }
      
      // Set up order parameters
      orderParams = {
        contract: contractDetails.contract_id.toString(),
        type: isMarket ? 'market' : 'limit',
        limit_price: isMarket ? '0' : limitPrice,
        time_in_force: 'GTC',
        reduce_only: false
      };
      
      // Add quantity with direction
      const formattedQuantity = orderSide.toLowerCase() === 'buy' ? quantity.toString() : `-${quantity}`;
      orderParams.quantity_contracts = formattedQuantity;
    } catch (error) {
      console.log('\nCould not automatically parse AI recommendation. Falling back to manual entry...');
      console.log(`Error: ${error.message}`);
      
      // Manual fallback if parsing fails
      const contractSymbol = await question('Enter the symbol of the contract to trade: ');
      
      // Find the contract
      const manualContract = contracts.find(c => c.symbol.toLowerCase() === contractSymbol.toLowerCase());
      if (!manualContract) {
        console.log(`Contract ${contractSymbol} not found.`);
        return;
      }
      
      // Get contract details
      const manualContractDetails = await getContractDetails(manualContract.contract_id);
      if (!manualContractDetails) {
        console.log(`Could not get details for contract ${contractSymbol}.`);
        return;
      }
      
      console.log(`\nCreating order for ${manualContract.symbol}...`);
      
      // Get order side
      while (true) {
        orderSide = await question('Order side (buy/sell): ');
        if (orderSide.toLowerCase() === 'buy' || orderSide.toLowerCase() === 'sell') break;
        console.log('Invalid order side. Please enter "buy" or "sell".');
      }
      
      // Get price and create an order
      const marketOrLimit = await question('Market or limit order? (market/limit): ');
      isMarket = marketOrLimit.toLowerCase() === 'market';
      
      let manualLimitPrice = '0';
      if (!isMarket) {
        manualLimitPrice = await question('Limit price: ');
      }
      
      // Get quantity
      const manualQuantity = await question('Quantity (in contracts): ');
      
      // Set up order parameters
      orderParams = {
        contract: manualContractDetails.contract_id.toString(),
        type: isMarket ? 'market' : 'limit',
        limit_price: isMarket ? '0' : manualLimitPrice,
        time_in_force: 'GTC',
        reduce_only: false
      };
      
      // Add quantity with direction
      const formattedQuantity = orderSide.toLowerCase() === 'buy' ? manualQuantity : `-${manualQuantity}`;
      orderParams.quantity_contracts = formattedQuantity;
    }
    
    // Step 8: Estimate the order
    console.log('\nEstimating order...');
    try {
      // Check if orderParams is defined
      if (!orderParams) {
        console.log('Error: Order parameters not properly defined.');
        return;
      }
      
      const estimationResult = await apiRequest('POST', '/v1/trading/estimate-order', orderParams);
      
      if (estimationResult) {
        console.log('\nOrder Estimation Result:');
        console.log('-'.repeat(50));
        
        if (estimationResult.error) {
          console.log(`Error: ${estimationResult.error}`);
          return;
        }
        
        // Determine order side based on quantity_contracts (safer than using orderSide variable)
        const effectiveOrderSide = orderParams.quantity_contracts.startsWith('-') ? 'SELL' : 'BUY';
        const effectiveOrderType = orderParams.type ? orderParams.type.toUpperCase() : 'MARKET';
        
        console.log(`Order Type:                 ${effectiveOrderSide} ${effectiveOrderType}`);
        console.log(`Trading Fee:                ${formatNumber(estimationResult.trading_fee)}`);
        console.log(`Operational Fee:            ${formatNumber(estimationResult.operational_fee)}`);
        console.log(`Realized Profit:            ${formatNumber(estimationResult.realized_profit)}`);
        console.log(`Taker Amount (Base):        ${formatNumber(estimationResult.taker_base_amount)}`);
        console.log(`Taker Amount (Tokens):      ${formatNumber(estimationResult.taker_tokens_amount)}`);
        console.log(`Current Equity:             ${formatNumber(estimationResult.current_equity)}`);
        console.log(`New Equity:                 ${formatNumber(estimationResult.new_equity)}`);
        console.log(`Current Leverage:           ${formatNumber(estimationResult.current_leverage)}`);
        console.log(`New Leverage:               ${formatNumber(estimationResult.new_leverage)}`);
        console.log(`Est. Liquidation Price:     ${formatNumber(estimationResult.estimated_liquidation_price)}`);
        console.log('-'.repeat(50));
        
        // Create order data for placement
        const orderData = {
          estimationResult,
          orderParams: {
            customer_order_id: `cli-ai-${Date.now()}`,
            contract: orderParams.contract,
            type: orderParams.type || 'market',
            limit_price: orderParams.limit_price || '0',
            time_in_force: orderParams.time_in_force || 'GTC',
            reduce_only: typeof orderParams.reduce_only === 'boolean' ? orderParams.reduce_only : false,
            quantity_contracts: orderParams.quantity_contracts,
            timestamp: Date.now(),
            recv_window: 30000
          }
        };
        
        // Place the order
        await placeOrder(orderData, question);
      }
    } catch (error) {
      console.error('Error estimating order:', error.message);
    }
  } catch (error) {
    console.error('Error analyzing market opportunities:', error.message);
  }
}

// Helper function to calculate price volatility
function calculateVolatility(prices) {
  try {
    if (!prices || !Array.isArray(prices) || prices.length < 2) return "N/A";
    
    // Filter out invalid price data
    const validPrices = prices.filter(p => !isNaN(p) && p > 0);
    if (validPrices.length < 2) return "Insufficient data";
    
    try {
      // Calculate returns
      const returns = [];
      for (let i = 1; i < validPrices.length; i++) {
        // Avoid division by zero
        if (validPrices[i-1] !== 0) {
          returns.push((validPrices[i] - validPrices[i-1]) / validPrices[i-1]);
        }
      }
      
      if (returns.length === 0) return "Calculation error";
      
      // Calculate standard deviation of returns
      const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      
      // Check for NaN or Infinite values
      if (isNaN(stdDev) || !isFinite(stdDev)) return "Calculation error";
      
      // Annualize the volatility (assuming hourly data)
      const annualizedVol = stdDev * Math.sqrt(24 * 365) * 100;
      
      if (annualizedVol < 50) return "Low";
      if (annualizedVol < 100) return "Medium";
      return "High";
    } catch (error) {
      console.log(`Error calculating volatility: ${error.message}`);
      return "Calculation error";
    }
  } catch (outerError) {
    // Extra safety layer
    console.log(`Unexpected error in volatility calculation: ${outerError.message}`);
    return "Error";
  }
}

// Helper function to analyze price trend
function analyzePriceTrend(prices) {
  try {
    if (!prices || !Array.isArray(prices) || prices.length < 6) return "Insufficient data";
    
    // Check if we have enough valid prices (not NaN)
    const validPrices = prices.filter(p => !isNaN(p));
    if (validPrices.length < 6) return "Insufficient valid data";
    
    // Simple moving average
    try {
      const shortTermAvg = validPrices.slice(-3).reduce((sum, p) => sum + p, 0) / 3;
      const longTermAvg = validPrices.slice(-12).reduce((sum, p) => sum + p, 0) / Math.min(12, validPrices.length);
      
      // Protect against division by zero or invalid values
      if (isNaN(shortTermAvg) || isNaN(longTermAvg) || longTermAvg === 0) return "Calculation error";
      
      // Trend detection
      if (shortTermAvg > longTermAvg * 1.03) return "Strong uptrend";
      if (shortTermAvg > longTermAvg * 1.01) return "Moderate uptrend";
      if (shortTermAvg < longTermAvg * 0.97) return "Strong downtrend";
      if (shortTermAvg < longTermAvg * 0.99) return "Moderate downtrend";
      return "Sideways";
    } catch (error) {
      console.log(`Error in trend calculation: ${error.message}`);
      return "Calculation error";
    }
  } catch (outerError) {
    // Extra safety layer
    console.log(`Unexpected error in trend analysis: ${outerError.message}`);
    return "Error";
  }
}

// Helper function to parse opportunities from AI response
function parseOpportunitiesFromAIResponse(content) {
  try {
    // Initialize opportunities array
    const opportunities = [];
    
    // Use regex to find sections that start with "Opportunity X:" and continue until the next opportunity or end
    const opportunityPattern = /Opportunity\s+(\d+):([\s\S]*?)(?=Opportunity\s+\d+:|$)/gi;
    
    let match;
    while ((match = opportunityPattern.exec(content)) !== null) {
      try {
        const opportunityNumber = parseInt(match[1]);
        const opportunityText = match[2].trim();
        
        // Parse the opportunity details
        const opportunity = {
          number: opportunityNumber,
          symbol: extractValue(opportunityText, /Contract(?:\s+symbol)?:\s*([^\n,]+)/i) || 
                 extractValue(opportunityText, /Symbol:\s*([^\n,]+)/i) || 
                 extractValue(opportunityText, /([A-Z0-9]+-[A-Z0-9]+)/),
          action: extractValue(opportunityText, /Action:\s*([^\n,]+)/i) || 
                 extractBuyOrSell(opportunityText),
          entryPrice: extractValue(opportunityText, /Entry(?:\s+price)?:\s*([^\n,]+)/i) || 
                      extractPrice(opportunityText, /entry(?:\s+price)?[^\d]*(\d[\d,.]*)/i) || 
                      "0",
          stopLoss: extractValue(opportunityText, /Stop(?:\s+loss)?:\s*([^\n,]+)/i) || 
                    extractPrice(opportunityText, /stop(?:\s+loss)?[^\d]*(\d[\d,.]*)/i) || 
                    "0",
          takeProfit: extractValue(opportunityText, /Take(?:\s+profit)?:\s*([^\n,]+)/i) || 
                      extractPrice(opportunityText, /take(?:\s+profit)?[^\d]*(\d[\d,.]*)/i) || 
                      "0",
          positionSize: extractValue(opportunityText, /Position(?:\s+size)?:\s*([^\n,]+)/i) || 
                        extractValue(opportunityText, /size(?:\s+recommendation)?:\s*([^\n,]+)/i) || 
                        "small",
          riskLevel: extractValue(opportunityText, /Risk(?:\s+level)?:\s*([^\n,]+)/i) || 
                     "medium",
          rationale: extractValue(opportunityText, /Rationale:\s*([^\n]+(?:\n[^\n]+)*)/i) || 
                     extractLastSentence(opportunityText) || 
                     "No rationale provided"
        };
        
        // Add to opportunities array
        opportunities.push(opportunity);
      } catch (error) {
        console.log(`Error parsing opportunity ${match[1]}: ${error.message}`);
      }
    }
    
    // If no opportunities found using the pattern, try a more relaxed approach
    if (opportunities.length === 0) {
      // Look for any mentions of contracts and trading actions
      const contractPattern = /([A-Z0-9]+-[A-Z0-9]+)[^\n]*?(buy|sell)[^\n]*?(\d+(?:\.\d+)?)/gi;
      let simpleMatch;
      let count = 1;
      
      while ((simpleMatch = contractPattern.exec(content)) !== null) {
        try {
          opportunities.push({
            number: count++,
            symbol: simpleMatch[1],
            action: simpleMatch[2],
            entryPrice: simpleMatch[3],
            stopLoss: "0",
            takeProfit: "0",
            positionSize: "small",
            riskLevel: "medium",
            rationale: "Extracted from AI analysis"
          });
        } catch (error) {
          console.log(`Error creating simple opportunity: ${error.message}`);
        }
      }
    }
    
    // Return the opportunities array
    return opportunities;
  } catch (error) {
    console.log(`Error parsing opportunities from AI response: ${error.message}`);
    return [];
  }
}

// Helper function to extract values from text
function extractValue(text, pattern) {
  try {
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
  } catch (error) {
    return null;
  }
}

// Helper function to extract buy or sell action from text
function extractBuyOrSell(text) {
  try {
    // Check for "buy" or "sell" keywords with some context
    const buyMatch = text.match(/\b(buy|long)\b/i);
    const sellMatch = text.match(/\b(sell|short)\b/i);
    
    if (buyMatch && (!sellMatch || text.indexOf(buyMatch[0]) < text.indexOf(sellMatch[0]))) {
      return "buy";
    } else if (sellMatch) {
      return "sell";
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Helper function to extract price from text
function extractPrice(text, pattern) {
  try {
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
  } catch (error) {
    return null;
  }
}

// Helper function to extract the last sentence from text
function extractLastSentence(text) {
  try {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    return sentences.length > 0 ? sentences[sentences.length - 1].trim() : null;
  } catch (error) {
    return null;
  }
}

// Function to test the market analysis and order estimation functionality
async function testMarketAnalysisAndOrderEstimation(question) {
  try {
    console.log('\n=== TESTING MARKET ANALYSIS AND ORDER ESTIMATION ===');
    console.log('This is a test run to diagnose any issues in the flow.');
    
    // Step 1: Create mock AI analysis response
    const mockAIResponse = {
      choices: [{
        message: {
          content: `
Opportunity 1:
Contract: BTC-28MAR25
Action: Sell
Entry Price: 82,000
Stop Loss: 83,500
Take Profit: 80,000
Position Size: small
Risk Level: medium
Rationale: Price is showing signs of reversal after hitting resistance.

Opportunity 2:
Contract: ETH-28MAR25
Action: Buy
Entry Price: 2,100
Stop Loss: 2,050
Take Profit: 2,200
Position Size: medium
Risk Level: low
Rationale: ETH has found strong support and shows an upward trend.
          `
        }
      }]
    };
    
    // Step 2: Set up mock contract data
    const mockContracts = [
      {
        contract_id: 2,
        symbol: 'BTC-28MAR25',
        index: 'BTC',
        last_price: '82380',
        mark_price: '82458.743',
        volume_24h: '3192870.685'
      },
      {
        contract_id: 4,
        symbol: 'ETH-28MAR25',
        index: 'ETH',
        last_price: '2107',
        mark_price: '2110.0215',
        volume_24h: '246366.01'
      }
    ];
    
    // Step 3: Set up mock contract details
    const mockContractDetails = {
      contract_id: 2,
      symbol: 'BTC-28MAR25',
      index: 'BTC',
      index_id: 1,
      mark_price: '82458.743',
      last_price: '82380',
      min_order_size_contracts: '0.001',
      contract_size: '1'
    };
    
    // Step 4: Parse opportunities
    console.log('\nParsing opportunities from mock AI response...');
    const opportunities = parseOpportunitiesFromAIResponse(mockAIResponse.choices[0].message.content);
    console.log(`Found ${opportunities.length} opportunities:`);
    opportunities.forEach((opp, index) => {
      console.log(`\nOpportunity ${index + 1}:`);
      console.log(`- Symbol: ${opp.symbol}`);
      console.log(`- Action: ${opp.action}`);
      console.log(`- Entry Price: ${opp.entryPrice}`);
      console.log(`- Position Size: ${opp.positionSize}`);
    });
    
    // Step 5: Process mock opportunity 2 (ETH)
    console.log('\nProcessing opportunity 2 (ETH)...');
    const selectedOpp = opportunities[1]; // Use ETH opportunity
    
    // Variables for order parameters
    let orderParams = null;
    let orderSide = selectedOpp.action.toLowerCase();
    let isMarket = true;
    let quantity = 0.001;
    let limitPrice = selectedOpp.entryPrice;
    
    console.log('\nCreating order parameters...');
    
    // Create order parameters
    orderParams = {
      contract: "4", // ETH contract ID
      type: isMarket ? 'market' : 'limit',
      limit_price: isMarket ? '0' : limitPrice,
      time_in_force: 'GTC',
      reduce_only: false,
      quantity_contracts: orderSide === 'buy' ? quantity.toString() : `-${quantity}`
    };
    
    console.log('\nOrder parameters created:');
    console.log(JSON.stringify(orderParams, null, 2));
    
    // Step 6: Test order estimation
    console.log('\nWould normally estimate order here...');
    console.log(`Order parameters available: ${orderParams !== null}`);
    console.log(`Contract ID: ${orderParams.contract}`);
    console.log(`Order Side (from quantity): ${orderParams.quantity_contracts.startsWith('-') ? 'SELL' : 'BUY'}`);
    console.log(`Order Type: ${orderParams.type.toUpperCase()}`);
    console.log(`Quantity: ${Math.abs(parseFloat(orderParams.quantity_contracts))} contracts`);
    
    console.log('\n=== TEST COMPLETED ===');
    return {
      success: true,
      orderParams: orderParams,
      message: 'Test completed successfully'
    };
  } catch (error) {
    console.error('\n=== TEST FAILED ===');
    console.error(`Error: ${error.message}`);
    console.error(`Error stack: ${error.stack}`);
    return {
      success: false,
      error: error.message,
      message: 'Test failed - see error details above'
    };
  }
}

module.exports = {
  processNaturalLanguageOrder,
  analyzeMarketOpportunities,
  testMarketAnalysisAndOrderEstimation
};