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
    
    // Step 3: Gather market data for analysis
    console.log('\nGathering market data for analysis...');
    
    // We'll analyze up to 3 most actively traded contracts
    const contractsToAnalyze = [...contracts]
      .sort((a, b) => parseFloat(b.volume_24h) - parseFloat(a.volume_24h))
      .slice(0, 3);
    
    const marketData = [];
    
    // Collect detailed data for each contract
    for (const contract of contractsToAnalyze) {
      console.log(`Analyzing ${contract.symbol}...`);
      
      // Get contract details
      const details = await getContractDetails(contract.contract_id);
      
      // Get price history
      const priceHistory = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/price?period=1h&count=24`);
      
      // Get order book
      const orderBook = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/order-book?price_step=1`);
      
      // Get recent trades
      const recentTrades = await apiRequest('GET', `/v1/market/futures/${contract.contract_id}/latest-trades?count=20`);
      
      marketData.push({
        contract_id: contract.contract_id,
        symbol: contract.symbol,
        details,
        priceHistory: priceHistory.data || [],
        orderBook: orderBook || { bids: [], asks: [] },
        recentTrades: recentTrades.trades || []
      });
    }
    
    // Step 4: Use AI to analyze the market data and suggest opportunities
    console.log('\nAnalyzing market data with AI...');
    const openai = getOpenAIClient();
    
    // Prepare market data for AI analysis
    const marketSummary = marketData.map(market => {
      // Calculate basic metrics
      const prices = market.priceHistory.map(p => parseFloat(p.price_close));
      const latestPrice = prices.length > 0 ? prices[prices.length - 1] : 0;
      const priceChange24h = prices.length > 0 ? (latestPrice - prices[0]) / prices[0] * 100 : 0;
      
      // Calculate volume
      const volume24h = market.details ? parseFloat(market.details.volume_24h) : 0;
      
      // Calculate bid-ask spread
      const topBid = market.orderBook.bids.length > 0 ? parseFloat(market.orderBook.bids[0].price) : 0;
      const topAsk = market.orderBook.asks.length > 0 ? parseFloat(market.orderBook.asks[0].price) : 0;
      const spread = topAsk > 0 && topBid > 0 ? (topAsk - topBid) / topAsk * 100 : 0;
      
      // Analyze recent trade direction
      const recentTradesSell = market.recentTrades.filter(t => t.taker_side === 'sell').length;
      const recentTradesBuy = market.recentTrades.filter(t => t.taker_side === 'buy').length;
      const buyPressure = market.recentTrades.length > 0 ? 
        recentTradesBuy / market.recentTrades.length * 100 : 50;
      
      return {
        symbol: market.symbol,
        contract_id: market.contract_id,
        mark_price: market.details?.mark_price || 0,
        last_price: market.details?.last_price || 0,
        index_price: market.details?.index_price || 0,
        price_change_24h: priceChange24h.toFixed(2) + '%',
        volume_24h,
        open_interest: market.details?.open_interest || 0,
        bid_ask_spread: spread.toFixed(2) + '%',
        top_bid: topBid,
        top_ask: topAsk,
        buy_sell_ratio: `${buyPressure.toFixed(0)}% buy / ${(100 - buyPressure).toFixed(0)}% sell`,
        volatility: calculateVolatility(prices),
        price_trend: analyzePriceTrend(prices)
      };
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
    const selectedContract = await question('Enter the symbol of the contract to trade: ');
    
    // Find the contract
    const contract = contracts.find(c => c.symbol.toLowerCase() === selectedContract.toLowerCase());
    if (!contract) {
      console.log(`Contract ${selectedContract} not found.`);
      return;
    }
    
    // Get contract details
    const contractDetails = await getContractDetails(contract.contract_id);
    if (!contractDetails) {
      console.log(`Could not get details for contract ${selectedContract}.`);
      return;
    }
    
    // Step 7: Let user input order parameters based on AI suggestion
    console.log(`\nCreating order for ${contract.symbol}...`);
    
    // Get order side
    let orderSide;
    while (true) {
      orderSide = await question('Order side (buy/sell): ');
      if (orderSide.toLowerCase() === 'buy' || orderSide.toLowerCase() === 'sell') break;
      console.log('Invalid order side. Please enter "buy" or "sell".');
    }
    
    // Get price and create an order
    const marketOrLimit = await question('Market or limit order? (market/limit): ');
    const isMarket = marketOrLimit.toLowerCase() === 'market';
    
    let limitPrice = '0';
    if (!isMarket) {
      limitPrice = await question('Limit price: ');
    }
    
    // Get quantity
    const quantity = await question('Quantity (in contracts): ');
    
    // Set up order parameters
    const orderParams = {
      contract: contractDetails.contract_id.toString(),
      type: isMarket ? 'market' : 'limit',
      limit_price: isMarket ? '0' : limitPrice,
      time_in_force: 'GTC',
      reduce_only: false
    };
    
    // Add quantity with direction
    const formattedQuantity = orderSide.toLowerCase() === 'buy' ? quantity : `-${quantity}`;
    orderParams.quantity_contracts = formattedQuantity;
    
    // Step 8: Estimate the order
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
        
        console.log(`Order Type:                 ${orderSide.toUpperCase()} ${isMarket ? 'MARKET' : 'LIMIT'}`);
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
    console.error('Error analyzing market opportunities:', error.message);
  }
}

// Helper function to calculate price volatility
function calculateVolatility(prices) {
  if (!prices || prices.length < 2) return "N/A";
  
  // Calculate returns
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
  }
  
  // Calculate standard deviation of returns
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  // Annualize the volatility (assuming hourly data)
  const annualizedVol = stdDev * Math.sqrt(24 * 365) * 100;
  
  if (annualizedVol < 50) return "Low";
  if (annualizedVol < 100) return "Medium";
  return "High";
}

// Helper function to analyze price trend
function analyzePriceTrend(prices) {
  if (!prices || prices.length < 6) return "Insufficient data";
  
  // Simple moving average
  const shortTermAvg = prices.slice(-3).reduce((sum, p) => sum + p, 0) / 3;
  const longTermAvg = prices.slice(-12).reduce((sum, p) => sum + p, 0) / 12;
  
  // Trend detection
  if (shortTermAvg > longTermAvg * 1.03) return "Strong uptrend";
  if (shortTermAvg > longTermAvg * 1.01) return "Moderate uptrend";
  if (shortTermAvg < longTermAvg * 0.97) return "Strong downtrend";
  if (shortTermAvg < longTermAvg * 0.99) return "Moderate downtrend";
  return "Sideways";
}

module.exports = {
  processNaturalLanguageOrder,
  analyzeMarketOpportunities
};