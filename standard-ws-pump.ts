// standard-ws-pump.ts
import WebSocket from 'ws';
import { Buffer } from 'buffer';
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { SolanaEventParser } from "./utils/event-parser";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { parseSwapTransactionOutput } from "./utils/swapTransactionParser";
// @ts-ignore
import pumpFunAmmIdl from "./idls/pump_amm_0.1.0.json";

// Configuration
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000; // 1 second
let retryCount = 0;
let retryTimeout: NodeJS.Timeout | null = null;
let subscriptionId: number | null = null;

// Initialize tools and constants
const TXN_FORMATTER = new TransactionFormatter();
const PUMP_FUN_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_FUN_IX_PARSER = new SolanaParser([]);
PUMP_FUN_IX_PARSER.addParserFromIdl(PUMP_FUN_AMM_PROGRAM_ID.toBase58(), pumpFunAmmIdl);
const PUMP_FUN_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_FUN_EVENT_PARSER.addParserFromIdl(PUMP_FUN_AMM_PROGRAM_ID.toBase58(), pumpFunAmmIdl);

// Create a WebSocket connection
let ws: WebSocket;

// Function to decode PumpFun transaction
function decodePumpFunTxn(tx: VersionedTransactionResponse) {
  if (!tx.meta || tx.meta.err) return;
  try {
    const paredIxs = PUMP_FUN_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta.loadedAddresses,
    );

    const pumpFunIxs = paredIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_AMM_PROGRAM_ID) || 
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    const parsedInnerIxs = PUMP_FUN_IX_PARSER.parseTransactionWithInnerInstructions(tx);
    const pumpfun_amm_inner_ixs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_AMM_PROGRAM_ID) || 
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    if (pumpFunIxs.length === 0) return;
    
    const events = PUMP_FUN_EVENT_PARSER.parseEvent(tx);
    const result = { 
      instructions: { pumpFunIxs, events }, 
      inner_ixs: pumpfun_amm_inner_ixs 
    };
    bnLayoutFormatter(result);
    return result;
  } catch (err) {
    console.error('Error decoding transaction:', err);
    return null;
  }
}

// Helper to convert parser instructions to local types
function convertParsedInstructions(parsed: any): any {
  function toAccount(acc: any): { name: string; pubkey: string } {
    return {
      name: acc.name || '',
      pubkey: acc.pubkey || '',
    };
  }
  function toInstruction(ix: any): any {
    return {
      name: ix.name || '',
      accounts: (ix.accounts || []).map(toAccount),
      args: ix.args || {},
    };
  }
  return {
    instructions: {
      pumpFunIxs: (parsed.instructions.pumpFunIxs || []).map(toInstruction),
    },
    inner_ixs: (parsed.inner_ixs || []).map(toInstruction),
  };
}

function connect() {
  ws = new WebSocket(`wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);

  function sendRequest(ws: WebSocket): void {
    const request = {
      "jsonrpc": "2.0",
      "id": 420,
      "method": "transactionSubscribe",
      "params": [
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        {
            "commitment": "processed",
            "encoding": "jsonParsed",
            "transactionDetails": "full",
            "maxSupportedTransactionVersion": 0
        }
      ]
    };
    console.log('Sending subscription request:', JSON.stringify(request, null, 2));
    ws.send(JSON.stringify(request));
  }

  function startPing(ws: WebSocket): void {
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('Ping sent');
      }
    }, 30000);
  }

  ws.on('open', function open() {
    console.log('WebSocket is open');
    retryCount = 0;
    sendRequest(ws);
    startPing(ws);
  });

  ws.on('message', function incoming(data: WebSocket.Data) {
    const messageStr = data.toString('utf8');
    try {
      const messageObj = JSON.parse(messageStr);

      if (messageObj.result && typeof messageObj.result === 'number') {
        subscriptionId = messageObj.result;
        console.log('Successfully subscribed with ID:', subscriptionId);
        return;
      }

      console.log(messageObj);

      if (messageObj.method === 'programNotification' && messageObj.params?.result) {
        const { context, value } = messageObj.params.result;
        
        if (value.transaction) {
          // Format the transaction
          const txn = TXN_FORMATTER.formTransactionFromJson(
            value,
            Date.now()
          );

          // Parse PumpFun transaction
          const parsedTxn = decodePumpFunTxn(txn);
          if (!parsedTxn) return;

          // Convert to local types for swap parser
          const convertedParsedTxn = convertParsedInstructions(parsedTxn);

          // Parse swap transaction output
          const formattedSwapTxn = parseSwapTransactionOutput(convertedParsedTxn, txn);
          if (!formattedSwapTxn) return;

          // Log transaction details
          console.log(
            new Date(),
            ":",
            `New transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]} \n`,
            JSON.stringify(formattedSwapTxn.output, null, 2) + "\n",
            formattedSwapTxn.transactionEvent
          );
          console.log(
            "--------------------------------------------------------------------------------------------------"
          );
        }
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
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

process.on('SIGINT', () => {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }
  if (ws) {
    ws.close();
  }
  process.exit();
});