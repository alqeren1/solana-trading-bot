import {
  Keypair,
  Connection,
  BlockhashWithExpiryBlockHeight,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import { searcherClient as jitoSearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import fs from 'fs';
import bs58 from 'bs58';

// Read the wallet keypair from a file and initialize the Jito client.
const keypairArray = JSON.parse(fs.readFileSync('./solana_keypair.json', 'utf8'));
const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
const PRIVATE_KEY = process.env['PRIVATE_KEY'];
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY!));
const client = jitoSearcherClient("amsterdam.mainnet.block-engine.jito.wtf", keypair, {
  'grpc.keepalive_timeout_ms': 5000,
});

export class JitoTransactionExecutor implements TransactionExecutor {
  constructor(private readonly connection: Connection) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair, // Correct parameter added based on interface expectation
    latestBlockhash: BlockhashWithExpiryBlockHeight
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    try {
      logger.info('Starting Jito transaction execution...');

      // Serialize the transaction for the Jito bundle
      const txBundle = transaction;
      txBundle.sign([wallet]);
      // Create the Jito bundle and send it
      await client.sendBundle(new JitoBundle([txBundle], 2));

      const signature = await this.connection.sendRawTransaction(txBundle.serialize(), {
        preflightCommitment: this.connection.commitment,
      });
      logger.info(`Transaction sent with signature: ${signature}`);

      // Wait for confirmation with timeout
      return await this.confirmWithTimeout(signature, latestBlockhash, 10000); // 6000 ms = 6 seconds
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Error during Jito transaction execution:', {
          message: error.message, // Detailed error message
          stack: error.stack,    // Stack trace for debugging
        });
        console.log(error);
      } else {
        // If it's not a standard Error object, log the entire error
        logger.error('Error during Jito transaction execution:', error);
        console.log(error);
      }
      return { confirmed: false };
    }
  }

  private async confirmWithTimeout(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight, timeout: number) {
    const timeoutPromise = new Promise<{ confirmed: boolean; signature?: string; error?: string }>((_, reject) =>
      setTimeout(() => reject(new Error('Transaction confirmation timed out')), timeout)
    );

    const confirmPromise = this.confirm(signature, latestBlockhash);

    try {
      return await Promise.race([confirmPromise, timeoutPromise]);
    } catch (error) {
      logger.error('Transaction confirmation timed out or failed', { signature });
      return { confirmed: false, error: 'Transaction confirmation timed out' };
    }
  }

  private async confirm(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight) {
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      this.connection.commitment // Use the appropriate commitment level for your needs
    );

    return { confirmed: !confirmation.value.err, signature };
  }
}
