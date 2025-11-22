import { ethers } from 'ethers';
import axios from 'axios';
import { NextResponse } from 'next/server';

// Helper to get API keys from env
const getApiKey = (chain) => {
  if (chain === 'tron') return process.env.TRONSCAN_API_KEY;
  if (chain === 'bsc') return process.env.BSCSCAN_API_KEY;
  // Etherscan V2 uses a single key for all supported chains
  return process.env.ETHERSCAN_API_KEY;
};

const getChainId = (chain, network) => {
  if (chain === 'ethereum') return network === 'mainnet' ? 1 : 11155111; // Sepolia
  if (chain === 'polygon') return network === 'mainnet' ? 137 : 80002; // Amoy
  if (chain === 'bsc') return network === 'mainnet' ? 56 : 97;
  if (chain === 'tron') return network === 'mainnet' ? 'mainnet' : 'shasta';
  throw new Error(`Unsupported chain/network: ${chain}/${network}`);
};

const getRpcUrl = (chain, network) => {
  const alchemyKey = process.env.ALCHEMY_API_KEY;

  if (chain === 'tron') {
    if (network === 'shasta') return 'https://api.shasta.trongrid.io';
    return 'https://api.trongrid.io';
  }

  if (!alchemyKey) throw new Error('Alchemy API Key missing');

  if (chain === 'ethereum') {
    return network === 'mainnet'
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`;
  }
  if (chain === 'polygon') {
    return network === 'mainnet'
      ? `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : `https://polygon-amoy.g.alchemy.com/v2/${alchemyKey}`;
  }
  if (chain === 'bsc') {
    return network === 'mainnet'
      ? `https://bnb-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : `https://bnb-testnet.g.alchemy.com/v2/${alchemyKey}`;
  }

  throw new Error(`Unsupported chain: ${chain}`);
};

const getExplorerApiUrl = (chain, network) => {
  if (chain === 'tron') {
    if (network === 'shasta') return 'https://shastapi.tronscan.org/api';
    return 'https://apilist.tronscanapi.com/api';
  }
  if (chain === 'bsc') {
    if (network === 'testnet') return 'https://api-testnet.bscscan.com/api';
    return 'https://api.bscscan.com/api';
  }
  // Unified V2 endpoint for all EVM chains (except BSC)
  return 'https://api.etherscan.io/v2/api';
};

// Helper for rate-limited requests
async function fetchWithRetry(url, config, retries = 5, backoff = 3000) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    if (retries > 0 && error.response?.status === 429) {
      console.warn(`Rate limited (429). Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      return fetchWithRetry(url, config, retries - 1, backoff * 2);
    }
    throw error;
  }
}

async function getTronBlockNumberByTimestamp(network, timestamp) {
  // TronScan doesn't have exact timestamp lookup, so we search a range
  // Search 1 hour window around timestamp
  const start = (timestamp - 3600) * 1000;
  const end = (timestamp + 3600) * 1000;
  const apiKey = getApiKey('tron');

  // Base URL depends on network
  let baseUrl = 'https://apilist.tronscanapi.com/api';
  if (network === 'shasta') baseUrl = 'https://shastapi.tronscan.org/api';

  const url = `${baseUrl}/block?sort=-timestamp&limit=1&start_timestamp=${start}&end_timestamp=${end}`;

  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};

  const { data } = await fetchWithRetry(url, { headers });
  if (!data.data || data.data.length === 0) {
    // Try wider range or just end_timestamp
    const preciseUrl = `${baseUrl}/block?sort=-timestamp&limit=1&end_timestamp=${timestamp * 1000}`;
    const { data: preciseData } = await fetchWithRetry(preciseUrl, { headers });
    if (!preciseData.data || preciseData.data.length === 0) {
      throw new Error('No Tron block found before this timestamp');
    }
    return preciseData.data[0].number;
  }

  return data.data[0].number;
}

async function getBscBlockNumberByTimestamp(network, timestamp) {
  // 1. Try DefiLlama for Mainnet (Fast & Free)
  if (network === 'mainnet') {
    try {
      // console.log(`Fetching BSC block from LlamaFi for timestamp ${timestamp}`);
      const { data } = await axios.get(`https://coins.llama.fi/block/bsc/${timestamp}`);
      return data.height;
    } catch (e) {
      console.warn('LlamaFi failed, falling back to RPC', e);
    }
  }

  // 2. RPC Binary Search (For Testnet or Mainnet fallback)
  // console.log(`Performing RPC binary search for BSC ${network} block at ${timestamp}`);
  const rpcUrl = getRpcUrl('bsc', network);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const latestBlock = await provider.getBlock('latest');
  if (latestBlock.timestamp < timestamp) {
    console.warn('BSC Timestamp is in the future, falling back to latest block');
    return latestBlock.number;
  }

  let min = 0;
  let max = latestBlock.number;
  let closestBlock = max;

  // Optimization: Estimate start block based on avg block time (3s)
  // This speeds up the search significantly
  const avgBlockTime = 3;
  const timeDiff = latestBlock.timestamp - timestamp;
  const estimatedBlockDiff = Math.floor(timeDiff / avgBlockTime);
  const estimatedBlock = Math.max(0, latestBlock.number - estimatedBlockDiff);

  // Narrow search window around estimate (e.g. +/- 100k blocks)
  // If estimate is way off, binary search still works, just takes a few more steps
  min = Math.max(0, estimatedBlock - 100000);
  max = Math.min(latestBlock.number, estimatedBlock + 100000);

  // If outside window, reset to full range (safety net)
  const minBlock = await provider.getBlock(min);
  const maxBlock = await provider.getBlock(max);
  if (minBlock.timestamp > timestamp || maxBlock.timestamp < timestamp) {
    min = 0;
    max = latestBlock.number;
  }

  while (min <= max) {
    const mid = Math.floor((min + max) / 2);
    const block = await provider.getBlock(mid);

    if (block.timestamp >= timestamp) {
      closestBlock = mid;
      max = mid - 1;
    } else {
      min = mid + 1;
    }
  }

  return closestBlock;
}

async function getBlockNumberByTimestamp(chain, network, timestamp) {
  if (chain === 'tron') {
    return getTronBlockNumberByTimestamp(network, timestamp);
  }

  if (chain === 'bsc') {
    return getBscBlockNumberByTimestamp(network, timestamp);
  }

  const apiKey = getApiKey(chain);
  const baseUrl = getExplorerApiUrl(chain, network);

  let url = `${baseUrl}?module=block&action=getblocknobytime&timestamp=${timestamp}&closest=before&apikey=${apiKey}`;

  // Etherscan V2 requires chainid
  if (baseUrl.includes('/v2/api')) {
    const chainId = getChainId(chain, network);
    url += `&chainid=${chainId}`;
  }

  // console.log(`Fetching block number from Explorer: ${url}`);

  const { data } = await axios.get(url);
  if (data.status !== '1') {
    // Handle "Block timestamp too far in the future" error
    if (data.message === 'NOTOK' && data.result && data.result.includes('future')) {
      console.warn('Timestamp is in the future, falling back to latest block');
      // For Etherscan V2, we can't easily get "latest" via this endpoint, 
      // but we can assume the user wants the current state.
      // However, we need a block number. Let's fetch the latest block via RPC.
      const rpcUrl = getRpcUrl(chain, network);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const latestBlock = await provider.getBlockNumber();
      return latestBlock;
    }

    console.error(`Explorer API Error Response:`, data);
    throw new Error(`Explorer API error: ${data.message} (${data.result})`);
  }
  return Number(data.result);
}

async function getTronBlockHashByNumber(network, blockNumber) {
  const nodeUrl = getRpcUrl('tron', network);
  try {
    const { data } = await axios.post(`${nodeUrl}/wallet/getblockbynum`, { num: blockNumber });
    if (!data || !data.blockID) {
      throw new Error('Failed to get block hash');
    }
    return data.blockID;
  } catch (e) {
    console.error("Error fetching Tron block hash:", e);
    throw e;
  }
}

async function getTronHistoricalBalance(address, network, targetTimestamp) {
  const apiKey = getApiKey('tron');
  const baseUrl = getExplorerApiUrl('tron', network);

  let allTransactions = [];
  let start = 0;
  const limit = 50;
  let hasMore = true;

  //console.log(`Fetching ALL Tron transactions for ${address}`);

  // Fetch ALL transactions (we need to see the initial funding)
  while (hasMore) {
    const url = `${baseUrl}/transaction?address=${address}&limit=${limit}&start=${start}&sort=-timestamp`;
    const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};

    try {
      const { data } = await fetchWithRetry(url, { headers });

      if (!data.data || data.data.length === 0) {
        hasMore = false;
        break;
      }

      allTransactions.push(...data.data);
      start += limit;

      // Safety limit: stop if we've fetched too many transactions
      if (allTransactions.length >= 10000) {
        console.warn('Too many transactions, stopping at 10000');
        hasMore = false;
      }
    } catch (e) {
      console.error('Error fetching Tron transactions:', e.response?.data || e.message);
      throw new Error(`Failed to fetch transactions: ${e.response?.status || e.message}`);
    }
  }

  //console.log(`Fetched ${allTransactions.length} total transactions`);

  // Sort ALL transactions by timestamp (oldest first)
  allTransactions.sort((a, b) => a.timestamp - b.timestamp);

  // Filter to only transactions before or at target timestamp
  const relevantTxs = allTransactions.filter(tx => tx.timestamp <= targetTimestamp);
  //console.log(`Found ${relevantTxs.length} transactions before target timestamp ${targetTimestamp}`);

  // Replay transactions to calculate balance
  let balance = 0;
  const hexAddress = toTronHex(address).toLowerCase();
  const base58Address = address.startsWith('T') ? address : null;

  //console.log(`\n=== Replaying ${relevantTxs.length} transactions for address: ${address}`);
  //console.log(`Hex format: ${hexAddress}\n`);

  for (const tx of relevantTxs) {
    // Skip failed transactions
    if (tx.contractRet !== 'SUCCESS') continue;

    // Handle different contract types
    if (tx.contractType === 1) { // TransferContract (TRX transfer)
      // Convert addresses to hex for comparison
      const ownerHex = tx.ownerAddress ? toTronHex(tx.ownerAddress).toLowerCase() : null;
      const toHex = tx.toAddress ? toTronHex(tx.toAddress).toLowerCase() : null;
      const amount = parseInt(tx.amount || 0);
      const fee = parseInt(tx.cost?.fee || 0);

      //console.log(`\nTx ${tx.hash?.substring(0, 8)}:`);
      //console.log(`  From: ${tx.ownerAddress} (${ownerHex?.substring(0, 10)}...)`);
      //console.log(`  To: ${tx.toAddress} (${toHex?.substring(0, 10)}...)`);
      //console.log(`  Amount: ${amount} sun, Fee: ${fee} sun`);

      if (toHex === hexAddress) {
        // Incoming transfer
        balance += amount;
        //console.log(`  ✅ INCOMING: +${amount} sun (new balance: ${balance})`);
      } else if (ownerHex === hexAddress) {
        // Outgoing transfer
        balance -= amount;
        balance -= fee;
        //console.log(`  ❌ OUTGOING: -${amount} sun, -${fee} fee (new balance: ${balance})`);
      } else {
        //console.log(`  ⚠️  SKIPPED: Not related to our address`);
      }
    }
    // Note: For TRC-20 tokens, we would need to parse contract data differently
    // For now, focusing on native TRX only
  }

  //console.log(`\n=== Final calculated balance: ${balance} sun (${balance / 1_000_000} TRX) ===\n`);

  return balance; // Return balance in sun (1 TRX = 1,000,000 sun)
}

import bs58 from 'bs58';

// Helper to convert Tron address to Hex
function toTronHex(address) {
  if (address.startsWith('0x')) {
    return '41' + address.substring(2);
  }
  if (address.startsWith('T')) {
    const bytes = bs58.decode(address);
    // Remove last 4 bytes (checksum)
    const hex = Buffer.from(bytes.slice(0, -4)).toString('hex');
    return hex;
  }
  return address;
}

async function getTronTokenInfo(tokenAddress, network) {
  const baseUrl = getExplorerApiUrl('tron', network);
  const apiKey = getApiKey('tron');
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};

  try {
    const { data } = await fetchWithRetry(`${baseUrl}/token_trc20?contract=${tokenAddress}`, { headers });
    if (data && data.trc20_tokens && data.trc20_tokens.length > 0) {
      return data.trc20_tokens[0];
    }
    return null;
  } catch (e) {
    console.error("Error fetching token info:", e);
    return null;
  }
}

async function getTronTokenHistoricalBalance(address, tokenAddress, network, targetTimestamp) {
  const apiKey = getApiKey('tron');
  const baseUrl = getExplorerApiUrl('tron', network);

  let allTransfers = [];
  let start = 0;
  const limit = 50;
  let hasMore = true;

  //console.log(`Fetching TRC-20 transfers for ${address} token ${tokenAddress}`);

  while (hasMore) {
    const url = `${baseUrl}/token_trc20/transfers?limit=${limit}&start=${start}&sort=-timestamp&count=true&relatedAddress=${address}&contract_address=${tokenAddress}`;
    const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};

    try {
      const { data } = await fetchWithRetry(url, { headers });

      if (!data.token_transfers || data.token_transfers.length === 0) {
        hasMore = false;
        break;
      }

      allTransfers.push(...data.token_transfers);
      start += limit;

      if (allTransfers.length >= 5000) { // Safety limit
        console.warn('Too many token transfers, stopping at 5000');
        hasMore = false;
      }
    } catch (e) {
      console.error('Error fetching TRC-20 transfers:', e.response?.data || e.message);
      throw new Error(`Failed to fetch token transfers: ${e.response?.status || e.message}`);
    }
  }

  // Sort by timestamp (oldest first)
  allTransfers.sort((a, b) => a.block_ts - b.block_ts);

  // Filter
  const relevantTransfers = allTransfers.filter(tx => tx.block_ts <= targetTimestamp);
  //console.log(`Found ${relevantTransfers.length} token transfers before target timestamp`);

  let balance = 0;

  for (const tx of relevantTransfers) {
    const amount = parseFloat(tx.quant);

    // Normalize addresses for comparison (TronScan returns Base58)
    if (tx.to_address === address) {
      balance += amount;
    } else if (tx.from_address === address) {
      balance -= amount;
    }
  }

  return balance;
}

export async function POST(request) {
  try {
    const body = await request.json();
    let { address, chain = 'ethereum', network = 'mainnet', date, tokenAddress } = body;

    if (!address || !date) {
      return NextResponse.json({ error: 'Address and Date are required' }, { status: 400 });
    }

    // Clean inputs
    address = address.trim();
    if (tokenAddress) tokenAddress = tokenAddress.trim();

    // Parse date to timestamp
    const ts = Math.floor(new Date(date).getTime() / 1000);

    // Get Block Number
    const blockNumber = await getBlockNumberByTimestamp(chain, network, ts);

    // Setup Provider
    const rpcUrl = getRpcUrl(chain, network);
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    let balanceWei;
    let symbol = 'ETH'; // Default
    if (chain === 'polygon') symbol = 'MATIC';
    if (chain === 'bsc') symbol = 'BNB';

    if (chain === 'tron') {
      symbol = 'TRX';

      let rawBalance;
      let balanceFormatted;
      let historicalBlockNumber;

      try {
        // Get block number at target timestamp
        historicalBlockNumber = await getBlockNumberByTimestamp(chain, network, ts);

        // Convert timestamp to milliseconds for TronScan API
        const targetTimestampMs = ts * 1000;

        if (tokenAddress) {
          // TRC-20 Logic
          //console.log(`Calculating TRC-20 historical balance for ${tokenAddress}`);

          // Get token info
          const tokenInfo = await getTronTokenInfo(tokenAddress, network);
          symbol = tokenInfo ? tokenInfo.symbol : 'UNKNOWN';
          const decimals = tokenInfo ? (tokenInfo.decimals || 18) : 18;

          rawBalance = await getTronTokenHistoricalBalance(address, tokenAddress, network, targetTimestampMs);
          balanceFormatted = (rawBalance / Math.pow(10, decimals)).toString();

        } else {
          // Native TRX Logic
          //console.log(`Calculating Tron historical balance at timestamp ${targetTimestampMs}`);
          rawBalance = await getTronHistoricalBalance(address, network, targetTimestampMs);
          balanceFormatted = (rawBalance / 1_000_000).toString();
        }

      } catch (e) {
        console.error("Tron balance error", e);
        throw new Error(`Failed to fetch Tron balance: ${e.message}`);
      }

      return NextResponse.json({
        chain,
        network,
        address,
        date,
        timestamp: ts,
        blockNumber: historicalBlockNumber,
        balance: balanceFormatted,
        symbol,
        rawBalance: rawBalance.toString(),
        note: 'Historical balance calculated via transaction replay'
      });
    }

    if (tokenAddress) {
      // ERC-20 Balance
      const ERC20_ABI = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)'
      ];
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      balanceWei = await contract.balanceOf(address, { blockTag: blockNumber });

      try {
        const [dec, sym] = await Promise.all([
          contract.decimals(),
          contract.symbol()
        ]);
        symbol = sym;
        // Format with specific decimals
        var balanceFormatted = ethers.formatUnits(balanceWei, dec);
      } catch (e) {
        // Fallback if decimals/symbol fail (some proxies might fail)
        var balanceFormatted = ethers.formatEther(balanceWei); // Assume 18
      }
    } else {
      // Native Balance
      balanceWei = await provider.getBalance(address, blockNumber);
      var balanceFormatted = ethers.formatEther(balanceWei);
    }

    return NextResponse.json({
      chain,
      network,
      address,
      date,
      timestamp: ts,
      blockNumber,
      balance: balanceFormatted,
      symbol,
      rawBalance: balanceWei.toString()
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
