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

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  degenMode: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  autoBurnCheck: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

const tipAddress = new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49');
const fee = process.env['CUSTOM_FEE'];
const LP_PERCENT = Number(process.env['LP_PERCENT'])
let stoplossdecrease = 0

let priceMatching = false;
let sellStarted = false;
export class Bot {
  private readonly poolFilters: PoolFilters;
  private readonly poolFilterExecutor: PoolFilterExecutor;
  private readonly dexinfoFilter: DexInfoFilter;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });
    this.poolFilterExecutor = new PoolFilterExecutor(connection);
    this.dexinfoFilter = new DexInfoFilter(connection);

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
            false,
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }
    if(sellStarted){
      console.log("--------------Sell function multicall blocked------------------")
      return;
    }
    sellStarted = true;

    try {

      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }
      let buyTime 

      if(this.config.autoBurnCheck > 0){
        buyTime = Math.floor(Date.now() / 1000);

      }

        
      

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys, buyTime!);
      sellStarted = false;

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          const ata = await getAssociatedTokenAddress(poolData.state.baseMint, this.config.wallet.publicKey);
          const balance1 = await this.connection.getTokenAccountBalance(ata)
          const balanceAmountString = balance1!.value.amount;
          const sellAmount1 =  new BN(balanceAmountString)
         
      
          const tokenAmountIn2 = new TokenAmount(tokenIn, sellAmount1, true);
          
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn2,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
            true,
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Dex view of sell tx, trade ended`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
    lastSell: boolean,
    
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });
  
    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });
  
    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction({
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: ataIn,
        tokenAccountOut: ataOut,
        owner: wallet.publicKey,
      },
      amountIn: amountIn.raw,
      minAmountOut: computedAmountOut.minAmountOut.raw,
    }, poolKeys.version);
  
    // Adding additional instructions depending on direction and other conditions
    const additionalInstructions = [
      ...(this.isWarp || this.isJito ? [] : [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
      ]),
      ...(direction === 'buy' ? [createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ataOut,
        wallet.publicKey,
        tokenOut.mint,
      )] : []),
      ...innerTransaction.instructions,
      ...(direction === 'sell' && lastSell ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
    ];
  
    // Adding the tip instruction
    
    const tipAmount = new CurrencyAmount(Currency.SOL, fee!, false).raw.toNumber();
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAddress,
      lamports: tipAmount,
    });
  
    // Combine all instructions, including the tip
    const allInstructions = [...additionalInstructions, tipInstruction];
  
    const transactionMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message();
  
    const transaction = new VersionedTransaction(transactionMessage);
    transaction.sign([wallet, ...innerTransaction.signers]);
  
    // Assuming this.txExecutor is an instance of JitoTransactionExecutor or similar
    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  
  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;
    if(this.config.degenMode){
    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;
          
          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);}

    else{
      
      this.poolFilters.removeFilter(BurnFilter);
      const shouldBuy = await this.poolFilters.execute(poolKeys);
      let burned = false
      if (shouldBuy) {
      logger.debug(
        { mint: poolKeys.baseMint.toString() },
        `Filter match ${matchCount}/${this.config.consecutiveMatchCount} now waiting for lp burn`,
      );
      const listTime = Math.floor(Date.now() / 1000);
      /*this.poolFilters.addFilter(new BurnFilter(this.connection));
      this.poolFilters.removeFilter(LpFilter);*/
      const response1 = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
      const firstPoolSize = new TokenAmount(this.config.quoteToken, response1.value.amount, true);
      do {
        try {
          const currentTime = Math.floor(Date.now() / 1000);
          //burned = await this.poolFilters.execute(poolKeys);
          burned = await this.poolFilterExecutor.executeBurnFilter(poolKeys);
          const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
          const poolSize = new TokenAmount(this.config.quoteToken, response.value.amount, true);
          logger.info(
            { mint: poolKeys.baseMint.toString() },
            `First LP size ${firstPoolSize.toFixed(2)} ---- ${poolSize.toFixed(2)} Current size`,
          );
          if(poolSize.raw.lte((firstPoolSize.raw).div(new BN(2)))){
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Rugged, passing`,
            );
            /*this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
            this.poolFilters.removeFilter(BurnFilter);*/
            return false;
          }

          
          if (burned) {
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Lp burned, checking Dex info`,
            );
            let dexInfo 
            const lpBurnTime = Math.floor(Date.now() / 1000);
            while(true){
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Waiting for Dex info`,
            );
            const currentTime2 = Math.floor(Date.now() / 1000);
            dexInfo = await this.dexinfoFilter.execute(poolKeys);
            if(dexInfo.ok){
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Dex info available, buying`,
            );
            break

            }
            if((lpBurnTime+300)<currentTime2){
              logger.info(
                { mint: poolKeys.baseMint.toString() },
                `Runned out of time, passing`,
              );
              /*this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
              this.poolFilters.removeFilter(BurnFilter);*/
              return false;
            }
            await sleep(1000)
            }
            const response2 = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
            const poolSize2 = new TokenAmount(this.config.quoteToken, response2.value.amount, true);
            if(poolSize2.raw.gte(firstPoolSize.raw)){
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `LP burned, Dex info available, buying`,
            );
            /*this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
            this.poolFilters.removeFilter(BurnFilter);*/
            return true;
          }
          }
          if((listTime+300)<currentTime){
            logger.info(
              { mint: poolKeys.baseMint.toString() },
              `Runned out of time, passing`,
            );
            /*this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
            this.poolFilters.removeFilter(BurnFilter);*/
            return false;
          }
             
          
          
  
          await sleep(1000);
        } catch {
          logger.info(
            { mint: poolKeys.baseMint.toString() },
            `Some error happened while checking LP`,
          );
        }
      } while (!burned);}}

    return false;
  }

  private async sellHalfOLD(poolKeys: LiquidityPoolKeysV4, token: Token, amountToSell: BN, amountIn: TokenAmount) {
    const ataIn = await getAssociatedTokenAddress(token.mint, this.config.wallet.publicKey);
    const ataOut = this.config.quoteAta; // Assuming the quote ATA is pre-determined
    
    const sellResult = await this.swap(
      poolKeys,
      ataIn,
      ataOut,
      token,
      this.config.quoteToken,
      new TokenAmount(token, amountToSell, true),
      this.config.sellSlippage,
      this.config.wallet,
      'sell',
      false,
    );
  
    if (sellResult.confirmed) {
      const slippage = new Percent(0, 100);

      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys,
      });

      const amountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: amountIn,
        currencyOut: this.config.quoteToken,
        slippage,
      }).amountOut;
      logger.info({ mint: token.mint.toString(), amount: amountToSell.toString() }, `Successfully sold 50% of holdings at ${amountOut.toFixed()}`);
    } else {
      logger.error({ mint: token.mint.toString(), error: sellResult.error }, `Failed to sell 50% of holdings`);
    }
  }

  private async sellHalf(poolKeys: LiquidityPoolKeysV4, token: Token, amountToSell: BN, amountIn: TokenAmount) {
    const ataIn = await getAssociatedTokenAddress(token.mint, this.config.wallet.publicKey);
    const ataOut = this.config.quoteAta; // Assuming the quote ATA is pre-determined

    for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
            

            logger.info({ mint: token.mint.toString() }, `Attempt ${i + 1}/${this.config.maxSellRetries} to sell half`);

            const sellResult = await this.swap(
              poolKeys,
              ataIn,
              ataOut,
              token,
              this.config.quoteToken,
              new TokenAmount(token, amountToSell, true),
              this.config.sellSlippage,
              this.config.wallet,
              'sell',
              false,
            );

            if (sellResult.confirmed) {
                const slippage = new Percent(0, 100);

                const poolInfo = await Liquidity.fetchInfo({
                  connection: this.connection,
                  poolKeys,
                });

                const amountOut = Liquidity.computeAmountOut({
                  poolKeys,
                  poolInfo,
                  amountIn: amountIn,
                  currencyOut: this.config.quoteToken,
                  slippage,
                }).amountOut;
                logger.info(
                    { mint: token.mint.toString(), amount: amountToSell.toString(), signature: sellResult.signature },
                    `Successfully sold 50% of holdings at ${amountOut.toFixed()}`
                );
                logger.info(
                  {
                    dex: `https://dexscreener.com/solana/${token.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                    mint: token.mint.toString(),
                    signature: sellResult.signature,
                    url: `https://solscan.io/tx/${sellResult.signature}?cluster=${NETWORK}`,
                  },
                  `Dex view of sell half tx`,
                );
                break;
            } else {
                logger.info(
                    { mint: token.mint.toString(), error: sellResult.error },
                    `Error confirming sell transaction`
                );
            }
        } catch (error) {
            logger.error({ mint: token.mint.toString(), error }, `Error during sell attempt`);
        }
    }
}

  
private  calculateTakeProfit(quoteAmount: TokenAmount, takeProfitPercent: number) {
  const profitFraction = quoteAmount.mul(takeProfitPercent).numerator.div(new BN(100));
  return quoteAmount.add(new TokenAmount(this.config.quoteToken, profitFraction, true));
}
private calculateStopLoss(quoteAmount: TokenAmount, stopLossPercent: number) {
  const lossFraction = quoteAmount.mul(stopLossPercent-stoplossdecrease).numerator.div(new BN(100));
  if((stopLossPercent-stoplossdecrease)>10){
    stoplossdecrease = stoplossdecrease + 10
  }
  
  return quoteAmount.subtract(new TokenAmount(this.config.quoteToken, lossFraction, true));
}
  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4, time: number) {
    if(!priceMatching){
    priceMatching = true
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }
    let remainingTokens = amountIn.raw;
    console.log("im in pricecheck ")
    //const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    let takeProfit = this.config.quoteAmount.add(profitAmount);

    /*const profitFraction2 = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount2 = new TokenAmount(this.config.quoteToken, profitFraction, true);
    let takeProfit2 = this.config.quoteAmount.add(profitAmount);*/

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    let stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(1, 100);
    let timesChecked = 0;
    let burnChecked = false;
    const firstAmountIn = amountIn
    
    let isUpdating = false

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });


        console.log("Price check amointIn: "+firstAmountIn.raw)
        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: firstAmountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;
      
        
        const currentTime= Math.floor(Date.now() / 1000);
        if(!burnChecked && this.config.autoBurnCheck > 0 && (time + this.config.autoBurnCheck) <= currentTime){
          console.log("Buy time: "+ time + " wait time: "+ this.config.autoBurnCheck+ " Current time: "+ currentTime)
          /*this.poolFilters.addFilter(new BurnFilter(this.connection));
          this.poolFilters.removeFilter(LpFilter);
          const isLpBurned = await this.poolFilters.execute(poolKeys);*/
          const isLpBurned = await this.poolFilterExecutor.executeBurnFilter(poolKeys);
          burnChecked = true
          if (!isLpBurned) {
            // Proceed with operations since the pool passed all filters
            logger.info('Pool didnt burn LP, selling');
           /* this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
            this.poolFilters.removeFilter(BurnFilter);*/
            break
        } else {
            // Handle the case where the pool did not pass the filters
            logger.info('Pool successfully burned LP, continuing to hold');
        }
        

        }
        logger.info(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );
        if (amountOut.lt(stopLoss)) {
          
          logger.info(
            { mint: poolKeys.baseMint.toString() },
            `Stop loss triggered, Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
          );
          
          priceMatching = false;
          break;
        
        
    
        

        }
        
          
        if (amountOut.gt(takeProfit) && !isUpdating) {
          isUpdating = true;
          const amountToSell = remainingTokens.div(new BN(2));
          console.log(`Selling half: Current tokens ${remainingTokens.toString()}, Selling ${amountToSell.toString()}`);
          remainingTokens = remainingTokens.sub(amountToSell);

          /*const lossFraction = takeProfit.mul(this.config.stopLoss).numerator.div(new BN(100));
          const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
          stopLoss = takeProfit.subtract(lossAmount);*/
          stopLoss = await this.calculateStopLoss(takeProfit, this.config.stopLoss);
          console.log(`New stop loss: ${stopLoss.toFixed()}`);

          /*const profitFraction = takeProfit.mul(this.config.takeProfit).numerator.div(new BN(100));
          const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
          takeProfit = takeProfit.add(profitAmount);*/
          takeProfit = await this.calculateTakeProfit(takeProfit, this.config.takeProfit);
          console.log(`New take profit: ${takeProfit.toFixed()}`);

          
          
          
          
          burnChecked = true // commentle eğer profit satıstan sonra burn check bitsin istemiyorsan
          await this.sellHalf(poolKeys, amountIn.token, amountToSell, amountIn);  //hepsini satma icin comment at
          console.log(`New remaining tokens: ${remainingTokens.toString()}`);
          isUpdating = false;
          //break
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (true);
    //while (timesChecked < timesToCheck);
  }
  else{
    console.log("-------------Double entrance to price match blocked--------------")
    return
  }
}}
