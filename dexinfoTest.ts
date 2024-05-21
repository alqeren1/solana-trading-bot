
import { Filter, FilterResult } from './filters/pool-filters'; // adjust the import path as necessary
import { Connection } from '@solana/web3.js';

import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from './helpers'; // adjust the import path as necessary

import axios from 'axios';


async function execute() {
    const url = `https://api.dexscreener.com/latest/dex/tokens/E7k72zBaN82HUR2AfUL3QqqzeuQNv4W5EJTg8f3h4Jv7`;
    try {
        const response = await axios.get(url);
        const data = response.data; // axios automatically parses the JSON response
        if (data.pairs && data.pairs.length > 0 && data.pairs[0].info) {
            console.log("Info is present");
            return { ok: true, message: "Info is present" };
        } else {
            console.log("No info availableS")
            return { ok: false, message: "No 'info' field present in the API response." };
        }
    } catch (error) {
        console.error(`Error fetching data from DexScreener: ${error}`);
        return { ok: false, message: 'Failed to fetch data from DexScreener' };
    }
}
execute()