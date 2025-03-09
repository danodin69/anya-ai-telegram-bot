// ai.js - AI-assisted order creation actions
const { OpenAI } = require('openai');
const { apiRequest, formatNumber } = require('./utils');
const { listContracts, getContractDetails } = require('./markets');
const { estimateOrder, placeOrder } = require('./trading');
const { getConfig } = require('./config');

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

module.exports = {
  processNaturalLanguageOrder
};