import { RootstockOperation } from '@rsksmart/rif-rollup-js-sdk';
import { BigNumber } from 'ethers';
import { PreparedDeposit, executeDeposits, generateDeposits, resolveDeposits } from '../operations/deposit';
import config from '../utils/config.utils';
import { generateL1Wallets } from '../utils/wallet.utils';
import { SimulationConfiguration } from './setup';
import { ensureFunds } from '../operations/common';

const runSimulation = async ({ l1WalletGenerator, funderL2Wallet, txCount, txDelay }: SimulationConfiguration) => {
    const { numberOfAccounts } = config;
    console.log('Creating deposit recipients from HD wallet ...');
    const recipients = generateL1Wallets(numberOfAccounts - 1, l1WalletGenerator);
    console.log(`Created ${recipients.length} recipients.`);

    const preparedDeposits: PreparedDeposit[] = generateDeposits(txCount, funderL2Wallet, recipients);
    console.log(`Created ${preparedDeposits.length} deposits`);

    // Verify transactions
    const totalDepositAmount = preparedDeposits.reduce((accumulator: BigNumber, deposit) => {
        accumulator.add(deposit.amount);

        return accumulator;
    }, BigNumber.from(0));

    await ensureFunds(totalDepositAmount, funderL2Wallet);

    // Execute transactions
    const executedTx: Promise<RootstockOperation>[] = await executeDeposits(preparedDeposits, txDelay);

    // List execution results
    await resolveDeposits(executedTx);
};

export { runSimulation as runDepositSimulation };
