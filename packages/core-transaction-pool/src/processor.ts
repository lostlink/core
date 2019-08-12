import { app } from "@arkecosystem/core-container";
import { Database, Logger, P2P, State, TransactionPool } from "@arkecosystem/core-interfaces";
import { Handlers } from "@arkecosystem/core-transactions";
import { Interfaces, Transactions } from "@arkecosystem/crypto";
import assert from "assert";
import async from "async";
import { delay } from 'bluebird';
import pluralize from "pluralize";
import uuidv4 from "uuid/v4";
import { dynamicFeeMatcher } from "./dynamic-fee";
import { IDynamicFeeMatch } from "./interfaces";
import { WalletManager } from "./wallet-manager";
import { PoolBroker } from './worker/pool-broker';
import { IPendingTransactionJobResult } from './worker/types';
import { pushError } from './worker/utils';

export class Processor {

    public static async make(pool: TransactionPool.IConnection, walletManager: WalletManager): Promise<Processor> {
        return new Processor(pool, walletManager).init();
    }

    private cachedTransactionIds: Map<string, boolean> = new Map();
    private partialTickets: Map<string, IPendingTransactionJobResult> = new Map();
    private pendingTickets: Map<string, boolean> = new Map();
    private processedTickets: Map<string, TransactionPool.IFinishedTransactionJobResult> = new Map();

    private readonly poolBroker: PoolBroker;
    private readonly queue: async.AsyncQueue<{ job: IPendingTransactionJobResult }>;

    private constructor(private readonly pool: TransactionPool.IConnection, private readonly walletManager: WalletManager) {
        this.poolBroker = new PoolBroker((job: IPendingTransactionJobResult) => this.queue.push({ job }));

        this.queue = async.queue(({ job }: { job: IPendingTransactionJobResult }, cb) => {
            const { ticketId, validTransactions, } = job;

            app.resolvePlugin<Logger.ILogger>("logger").debug(
                `Received ticket ${ticketId} with ${validTransactions.length} valid transactions from worker.`,
            );

            delay(10)
                .then(() => {
                    try {
                        return this.finishTransactionJob(job, cb);
                    } catch (error) {
                        console.log(error.stack);
                        return cb();
                    }
                })
                .catch(error => {
                    console.log(error.stack);
                    return cb();
                });
        });

    }

    public getPendingTickets(): string[] {
        return [...this.pendingTickets.keys()];
    }

    public getProcessedTickets(): TransactionPool.IFinishedTransactionJobResult[] {
        return [...this.processedTickets.values()];
    }

    public hasPendingTicket(ticketId: string): boolean {
        return this.pendingTickets.has(ticketId);
    }

    public getProcessedTicket(ticketId: string): TransactionPool.IFinishedTransactionJobResult | undefined {
        return this.processedTickets.get(ticketId);
    }

    public async createTransactionsJob(transactions: Interfaces.ITransactionData[]): Promise<string> {
        const eligibleTransactions: Interfaces.ITransactionData[] = [];
        const partialPendingJobResult: IPendingTransactionJobResult = {
            ticketId: "",
            invalid: {},
            excess: {},
            errors: {},
            accept: {},
            broadcast: {},
            validTransactions: [],
        };

        const senderWallets: Record<string, State.IWallet> = {};
        for (const transaction of transactions) {
            if (this.cachedTransactionIds.has(transaction.id)) {
                continue;
            }

            this.cachedTransactionIds.set(transaction.id, true);

            // TODO: optimize
            if (!await this.preWorkerChecks(transaction, partialPendingJobResult)) {
                continue;
            }

            const senderWallet: State.IWallet = this.walletManager.findByPublicKey(transaction.senderPublicKey);
            senderWallets[transaction.senderPublicKey] = senderWallet;

            eligibleTransactions.push(transaction);
        }

        const ticketId: string = uuidv4();
        partialPendingJobResult.ticketId = ticketId;

        if (eligibleTransactions.length === 0) {
            this.writeResult(partialPendingJobResult, []);

        } else {
            this.pendingTickets.set(ticketId, true);

            // If the payload contained some invalid transactions store them temporary
            // and merge them into the result once the job finishes.
            if (Object.keys(partialPendingJobResult.errors).length > 0 || Object.keys(partialPendingJobResult.excess).length > 0) {
                this.partialTickets.set(ticketId, undefined);
            }

            await this.poolBroker.createJob({
                ticketId,
                transactions: eligibleTransactions,
                senderWallets,
            });
        }

        return ticketId;
    }

    private async init(): Promise<this> {
        await this.poolBroker.init();
        return this;
    }

    private async finishTransactionJob(pendingJob: IPendingTransactionJobResult, cb: any): Promise<void> {
        pendingJob.accept = {};
        pendingJob.broadcast = {};

        const acceptedTransactions: Interfaces.ITransaction[] = await this.performWalletChecks(pendingJob);

        await this.removeForgedTransactions(pendingJob);
        await this.addToTransactionPool(acceptedTransactions, pendingJob);

        if (Object.keys(pendingJob.broadcast).length > 0) {
            app.resolvePlugin<P2P.IPeerService>("p2p")
                .getMonitor()
                .broadcastTransactions(Object.values(pendingJob.broadcast));
        }

        this.writeResult(pendingJob, acceptedTransactions);

        return cb();
    }

    private async preWorkerChecks(transaction: Interfaces.ITransactionData, jobResult: IPendingTransactionJobResult): Promise<boolean> {
        try {

            if (await this.pool.has(transaction.id)) {
                pushError(jobResult, transaction.id, {
                    type: "ERR_DUPLICATE",
                    message: `Duplicate transaction ${transaction.id}`
                });

                return false;
            }

            // if (await this.pool.hasExceededMaxTransactions(transaction.senderPublicKey)) {
            //   jobResult.excess[transaction.id] = true;
            //  return false;
            // }

            const handler: Handlers.TransactionHandler = Handlers.Registry.get(transaction.type, transaction.typeGroup);

            if (!(await handler.canEnterTransactionPool(transaction, this.pool, undefined))) {
                return false;
            }

            return true;

        } catch (error) {
            pushError(jobResult, transaction.id, {
                type: "ERR_UNKNOWN",
                message: error.message
            });

            return false;
        }
    }

    private async performWalletChecks(pendingJob: IPendingTransactionJobResult): Promise<Interfaces.ITransaction[]> {
        const { validTransactions } = pendingJob;
        const acceptedTransactions: Interfaces.ITransaction[] = [];
        for (const { buffer, id } of validTransactions) {
            try {
                const transaction: Interfaces.ITransaction = Transactions.TransactionFactory.fromBytesUnsafe(buffer, id);

                try {
                    await this.walletManager.throwIfCannotBeApplied(transaction);
                    const dynamicFee: IDynamicFeeMatch = dynamicFeeMatcher(transaction);
                    if (!dynamicFee.enterPool && !dynamicFee.broadcast) {
                        pushError(pendingJob, transaction.id, {
                            type: "ERR_LOW_FEE",
                            message: "The fee is too low to broadcast and accept the transaction",
                        });

                        continue;

                    }

                    if (dynamicFee.enterPool) {
                        pendingJob.accept[transaction.id] = transaction;
                    }

                    if (dynamicFee.broadcast) {
                        pendingJob.broadcast[transaction.id] = transaction;
                    }

                    acceptedTransactions.push(transaction);

                } catch (error) {
                    pushError(pendingJob, transaction.id, {
                        type: "ERR_APPLY",
                        message: error.message,
                    });
                }
            } catch (error) {
                pushError(pendingJob, id, {
                    type: "ERR_UNKNOWN",
                    message: error.message
                });
            }
        }

        return acceptedTransactions;
    }

    private async removeForgedTransactions(pendingJob: IPendingTransactionJobResult): Promise<void> {
        const forgedIdsSet: string[] = await app
            .resolvePlugin<Database.IDatabaseService>("database")
            .getForgedTransactionsIds([
                ...new Set(
                    [
                        ...Object.keys(pendingJob.accept),
                        ...Object.keys(pendingJob.broadcast)
                    ])
            ]);

        for (const id of forgedIdsSet) {
            pushError(pendingJob, id, {
                type: "ERR_FORGED", message: "Already forged."
            });

            delete pendingJob.accept[id];
            delete pendingJob.broadcast[id];

            const index: number = pendingJob.validTransactions.findIndex(transaction => transaction.id === id);
            assert(index !== -1);
            pendingJob.validTransactions.splice(index, 1);
        }
    }

    private async addToTransactionPool(transactions: Interfaces.ITransaction[], pendingJob: IPendingTransactionJobResult): Promise<void> {
        const { notAdded } = await this.pool.addTransactions(transactions.filter(({ id }) => !!pendingJob.accept[id]));

        for (const item of notAdded) {
            delete pendingJob.accept[item.transaction.id];

            if (item.type !== "ERR_POOL_FULL") {
                delete pendingJob.broadcast[item.transaction.id];
            }

            pushError(pendingJob, item.transaction.id, {
                type: item.type,
                message: item.message
            });
        }
    }

    private writeResult(pendingJob: IPendingTransactionJobResult, validTransactions: Interfaces.ITransaction[]): void {
        const jobResult: TransactionPool.IFinishedTransactionJobResult = {
            ticketId: pendingJob.ticketId,
            accept: Object.keys(pendingJob.accept),
            broadcast: Object.keys(pendingJob.broadcast),
            invalid: Object.keys(pendingJob.invalid),
            excess: Object.keys(pendingJob.excess),
            errors: Object.keys(pendingJob.errors).length > 0 ? pendingJob.errors : undefined,
        }

        const partialResult: IPendingTransactionJobResult = this.partialTickets.get(jobResult.ticketId);
        if (partialResult !== undefined) {
            jobResult.invalid = {
                ...jobResult.invalid,
                ...Object.keys(partialResult.invalid),
            };

            // TODO: merge errors too

            jobResult.excess = Object.keys(partialResult.excess);
        }

        this.partialTickets.delete(jobResult.ticketId);
        this.pendingTickets.delete(jobResult.ticketId);
        this.processedTickets.set(jobResult.ticketId, jobResult);

        // TODO: optimize
        for (const ids of ["accept", "broadcast", "invalid", "excess"]) {
            for (const id of jobResult[ids]) {
                this.cachedTransactionIds.delete(id);
            }
        }

        this.printStats(jobResult, validTransactions);
    }

    private printStats(finishedJob: TransactionPool.IFinishedTransactionJobResult, validTransactions: Interfaces.ITransaction[]): void {
        const total: number = validTransactions.length + finishedJob.excess.length + finishedJob.invalid.length;
        const stats: string = ["accept", "broadcast", "excess", "invalid"]
            .map(prop => `${prop}: ${finishedJob[prop].length}`)
            .join(" ");

        app.resolvePlugin<Logger.ILogger>("logger").info(
            `Received ${pluralize("transaction", total, true)} (${stats}).`,
        );
    }

}
