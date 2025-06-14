// standard-ws-pump.ts
import WebSocket from 'ws';

// Configuration
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000; // 1 second
let retryCount = 0;
let retryTimeout: NodeJS.Timeout | null = null;
let subscriptionId: number | null = null;

// Create a WebSocket connection
let ws: WebSocket;

function connect() {
  ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);

  // Function to send a request to the WebSocket server
  function sendRequest(ws: WebSocket): void {
    const request = {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "logsSubscribe",
      "params": [
        {
          "mentions": ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]
        }
      ]
    };
    console.log('Sending subscription request:', JSON.stringify(request, null, 2));
    ws.send(JSON.stringify(request));
  }

  // Function to send a ping to the WebSocket server
  function startPing(ws: WebSocket): void {
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('Ping sent');
      }
    }, 30000); // Ping every 30 seconds
  }

  // Define WebSocket event handlers
  ws.on('open', function open() {
    console.log('WebSocket is open');
    retryCount = 0; // Reset retry count on successful connection
    sendRequest(ws); // Send a request once the WebSocket is open
    startPing(ws); // Start sending pings
  });

  ws.on('message', function incoming(data: WebSocket.Data) {
    const messageStr = data.toString('utf8');
    try {
      const messageObj = JSON.parse(messageStr);

      // Handle subscription confirmation
      if (messageObj.result && typeof messageObj.result === 'number') {
        subscriptionId = messageObj.result;
        console.log('Successfully subscribed with ID:', subscriptionId);
        return;
      }

      // Handle actual log data
      if (messageObj.params && messageObj.params.result) {
        const logData = messageObj.params.result;
        console.log('Received log data:', JSON.stringify(logData, null, 2));
        
        // Extract the transaction signature if available
        if (logData.signature) {
          console.log('Transaction signature:', logData.signature);
          // You can call getTransaction with this signature to get the full transaction details
        }
      } else {
        console.log('Received message:', JSON.stringify(messageObj, null, 2));
      }
    } catch (e) {
      console.error('Failed to parse JSON:', e);
    }
  });

  ws.on('error', function error(err: Error) {
    console.error('WebSocket error:', err);
  });

  ws.on('close', function close() {
    console.log('WebSocket is closed');
    if (subscriptionId) {
      console.log('Last subscription ID was:', subscriptionId);
    }
    reconnect();
  });
}

function reconnect() {
  if (retryCount >= MAX_RETRIES) {
    console.error('Max retry attempts reached. Please check your connection and try again.');
    return;
  }

  const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
  console.log(`Attempting to reconnect in ${delay/1000} seconds... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);

  retryTimeout = setTimeout(() => {
    retryCount++;
    connect();
  }, delay);
}

// Start the initial connection
connect();

// Cleanup function
process.on('SIGINT', () => {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }
  if (ws) {
    ws.close();
  }
  process.exit();
});