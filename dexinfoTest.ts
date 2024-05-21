
import { Filter, FilterResult } from './filters/pool-filters'; // adjust the import path as necessary
import { Connection } from '@solana/web3.js';

import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from './helpers'; // adjust the import path as necessary

import axios from 'axios';


async function execute() {
    const url = `https://api.dexscreener.com/latest/dex/tokens/BfYHw4sBWjonvZcD2mUHJNsrEtsi947EBJ64kXNwn1Z8`;
    try {
        const response = await axios.get(url);
        const data = response.data; // axios automatically parses the JSON response
        if (data.pairs && data.pairs.length > 0 && data.pairs[0].info) {
            console.log("Info is present");
            return { ok: true, message: "Info is present" };
        } else {
            console.log("sa")
            return { ok: false, message: "No 'info' field present in the API response." };
        }
    } catch (error) {
        console.error(`Error fetching data from DexScreener: ${error}`);
        return { ok: false, message: 'Failed to fetch data from DexScreener' };
    }
}
execute()