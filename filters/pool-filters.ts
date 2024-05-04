import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { LpFilter } from './lp.filter';

import { MutableFilter } from './mutable.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { CHECK_IF_BURNED, LP_PERCENT, CHECK_LP_PERCENT,CHECK_IF_FREEZABLE, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_MUTABLE, CHECK_IF_SOCIALS, logger } from '../helpers';

export interface Filter {
  execute(poolKeysV4: LiquidityPoolKeysV4): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
}

export class PoolFilters {
  private readonly filters: Filter[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    this.initializeFilters();
  }

  private initializeFilters(): void {
    if (CHECK_IF_BURNED) {
      this.filters.push(new BurnFilter(this.connection));
    }

    if (CHECK_LP_PERCENT) {
      this.filters.push(new LpFilter(this.connection, this.args.quoteToken, LP_PERCENT));
    }

    if (CHECK_IF_MINT_IS_RENOUNCED || CHECK_IF_FREEZABLE) {
      this.filters.push(new RenouncedFreezeFilter(this.connection, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_FREEZABLE));
    }

    
    if (CHECK_IF_MUTABLE || CHECK_IF_SOCIALS) {
    this.filters.push(new MutableFilter(this.connection, getMetadataAccountDataSerializer(), CHECK_IF_MUTABLE, CHECK_IF_SOCIALS));
    }
    if (!this.args.minPoolSize.isZero() || !this.args.maxPoolSize.isZero()) {
      this.filters.push(new PoolSizeFilter(this.connection, this.args.quoteToken, this.args.minPoolSize, this.args.maxPoolSize));
    }
  }

    public addFilter(filter: Filter): void {
      this.filters.push(filter);
      logger.info(`Added new filter: ${filter.constructor.name}`);
    }

  public async execute(poolKeys: LiquidityPoolKeysV4): Promise<boolean> {
    if (this.filters.length === 0) {
      return true;
    }

    const result = await Promise.all(this.filters.map(f => f.execute(poolKeys)));
    const pass = result.every(r => r.ok);

    if (!pass) {
      result.forEach(r => {
        if (!r.ok) logger.info(r.message);
      });
    }

    return pass;
  }
}



