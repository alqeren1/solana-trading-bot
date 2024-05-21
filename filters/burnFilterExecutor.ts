import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { BurnFilter } from './burn.filter';
import { logger } from '../helpers';

export class PoolFilterExecutor {
    private readonly connection: Connection;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    public async executeBurnFilter(poolKeys: LiquidityPoolKeysV4): Promise<boolean> {
        // Create a new instance of BurnFilter just for this check
        const burnFilter = new BurnFilter(this.connection);

        // Execute the burn filter directly
        const result = await burnFilter.execute(poolKeys);
        
        // Log the result if not passed
        if (!result.ok) {
            logger.info(result.message || "Burn check failed.");
        }

        return result.ok;
    }
}