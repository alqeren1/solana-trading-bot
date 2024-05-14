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

const tipAddress = new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY');
const fee = process.env['CUSTOM_FEE'];
const LP_PERCENT = Number(process.env['LP_PERCENT'])
export class Bot {
  private readonly poolFilters: PoolFilters;

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
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async sellHalf(poolKeys: LiquidityPoolKeysV4, token: Token, amountToSell: BN, amountIn: TokenAmount) {
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
      logger.info({ mint: token.mint.toString(), amount: amountToSell.toString() }, `Successfully sold 50% of holdings at ${amountOut}`);
    } else {
      logger.error({ mint: token.mint.toString(), error: sellResult.error }, `Failed to sell 50% of holdings`);
    }
  }
  

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4, time: number) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }
    let remainingTokens = amountIn.raw;

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    let takeProfit = this.config.quoteAmount.add(profitAmount);

    const profitFraction2 = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount2 = new TokenAmount(this.config.quoteToken, profitFraction, true);
    let takeProfit2 = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    let stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(1, 100);
    let timesChecked = 0;
    let burnChecked = false;
    const firstAmountIn = amountIn
    let amountOutStop = 0
    let firstTime = true
    

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });



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
          this.poolFilters.addFilter(new BurnFilter(this.connection));
          this.poolFilters.removeFilter(LpFilter);
          const isLpBurned = await this.poolFilters.execute(poolKeys);
          burnChecked = true
          if (!isLpBurned) {
            // Proceed with operations since the pool passed all filters
            logger.info('Pool didnt burn LP, selling');
            this.poolFilters.addFilter(new LpFilter(this.connection, this.config.quoteToken, LP_PERCENT!)); 
            this.poolFilters.removeFilter(BurnFilter);
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
          const amountOut2 = Liquidity.computeAmountOut({
            poolKeys,
            poolInfo,
            amountIn: firstAmountIn,
            currencyOut: this.config.quoteToken,
            slippage,
          }).amountOut;
          logger.info(
            { mint: poolKeys.baseMint.toString() },
            `Amount out 2: ${amountOut2.toFixed()}`,
          );
          
          if (amountOut2.lt(stopLoss)){
          
          break;
        }
        logger.info({
          message: "Wrong amountOut value, stoploss blocked",
      });
    
          amountOutStop = amountOutStop + 1
        }
          
        if (amountOut.gt(takeProfit)) {
          const amountToSell = remainingTokens.div(new BN(2));
          remainingTokens = remainingTokens.sub(amountToSell);

          const lossFraction = takeProfit.mul(this.config.stopLoss).numerator.div(new BN(100));
          const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
          stopLoss = takeProfit.subtract(lossAmount);

          const profitFraction = takeProfit.mul(this.config.takeProfit).numerator.div(new BN(100));
          const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
          takeProfit = takeProfit.add(profitAmount);
          amountOutStop = 0
          firstTime = false
          burnChecked = true // commentle eğer profit satıstan sonra burn check bitsin istemiyorsan
          await this.sellHalf(poolKeys, amountIn.token, amountToSell, amountIn);  //hepsini satma icin comment at
          //break
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }
}
