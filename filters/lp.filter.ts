import { Filter, FilterResult } from './pool-filters';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Connection } from '@solana/web3.js';
import { logger } from '../helpers';
import { MintLayout } from '../types';
import BigNumber from 'bignumber.js';

export class LpFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly maxLpPercent: Number,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.baseVault, this.connection.commitment);
      const poolSize = new BigNumber(response.value.amount);
      const maxLp = new BigNumber(this.maxLpPercent.toString());
      let { data } = (await this.connection.getAccountInfo(poolKeys.baseMint)) || {};
      const deserialize = MintLayout.decode(data!);
      const supply = new BigNumber(deserialize.supply.toString());
      const decimals = deserialize.decimals;
      const poolSize_ = poolSize.dividedBy(new BigNumber(10).pow(decimals))
      const totalSupply = supply.dividedBy(new BigNumber(10).pow(decimals));
      const lpPercent = poolSize_.dividedBy(totalSupply).multipliedBy(100);

      //console.log(`POOLSIZE (${poolSize_.toString()}): TOTAL SUPPLY ${totalSupply.toString()} `);
      console.log(`LP percent for mint (${poolKeys.baseMint.toString()}): ${lpPercent.toString()}% `);
      if(lpPercent.lte(maxLp)){
        return { ok: false, message: `LpPercent -> Threashold ${maxLp.toString()} > Lp percent ${lpPercent.toFixed().toString()}` };

      }
     
      return { ok: true, message: `CHECKED LP PERCENT -> Lp percent ${lpPercent.toFixed().toString()}  >= Threashold ${maxLp.toString()}` };
      
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint }, `Failed to check lp percent`);
      return { ok: false, message: 'LpPercent -> Failed to check pool size' };
    }
  }
}
