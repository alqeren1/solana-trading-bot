import axios from 'axios';
import { Filter, FilterResult } from './pool-filters'; // adjust the import path as necessary
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers'; // adjust the import path as necessary

export class DexInfoFilter implements Filter {
  constructor(private readonly connection: Connection) {}
  

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${poolKeys.baseMint}`;
    try {
      const response = await axios.get(url);
      const data= response.data;
      if (data.pairs && data.pairs.length > 0 && data.pairs[0].info) {
        return { ok: true }; // info exists
      } else {
        return { ok: false, message: "No 'info' field present in the API response." };
      }
    } catch (error) {
      logger.error(`Error fetching data from DexScreener for token ${poolKeys.baseMint}: ${error}`);
      return { ok: false, message: 'Failed to fetch data from DexScreener' };
    }
  }
}