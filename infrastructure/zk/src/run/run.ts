import { Command } from 'commander';
import toml from '@iarna/toml';
import * as utils from '../utils';
import { Wallet } from 'ethers';
import fs from 'fs';
import * as path from 'path';
import * as verifyKeys from './verify-keys';
import * as eventListener from './event-listener';
import * as dataRestore from './data-restore';
import * as docker from '../docker';
import * as walletGenerator from './generate-wallet';
import * as forcedExit from './forced-exit';

export { verifyKeys, dataRestore };

type Token = {
    decimals: number;
    symbol: string;
    name: string;
    address: string;
};

type PartialFeeTickerConfig = {
    fee_ticker: {
        unconditionally_valid_tokens: string | string[];
    };
};

export async function deployERC20(command: 'dev' | 'new', name?: string, symbol?: string, decimals?: string) {
    if (command == 'dev') {
        await utils.spawn(`yarn --silent --cwd contracts deploy-erc20 add-multi '[
            { "name": "wBTC", "symbol": "wBTC", "decimals":  8, "implementation": "RevertTransferERC20" },
            { "name": "RDOC", "symbol": "RDOC", "decimals": 18 },
            { "name": "USDRIF", "symbol": "USDRIF", "decimals": 18 },
            { "name": "RSK Infrastructure Framework", "symbol": "RIF", "decimals": 18  }
          ]' > ./etc/tokens/localhost.json`);

        // Update the fee ticker configuration file with the deployed unconditionally valid erc20 tokens
        const localhostTokensFile = fs.readFileSync('./etc/tokens/localhost.json', 'utf-8');
        const tokens: Token[] = localhostTokensFile && JSON.parse(localhostTokensFile);
        const deployedUnconditionallyValidAddresses =
            (tokens &&
                tokens
                    .filter((token) => ['USDRIF', 'RDOC', 'RIF'].includes(token.symbol))
                    .map(({ address }) => address)) ||
            [];

        const feeTickerConfigFile = fs.readFileSync('./etc/env/dev/fee_ticker.toml', 'utf-8');
        const feeTicker = feeTickerConfigFile && (toml.parse(feeTickerConfigFile) as PartialFeeTickerConfig);
        let unconditionallyValidTokens = feeTicker && feeTicker.fee_ticker.unconditionally_valid_tokens;

        if (!Array.isArray(unconditionallyValidTokens)) {
            unconditionallyValidTokens = [unconditionallyValidTokens];
        }
        if (feeTicker) {
            feeTicker.fee_ticker.unconditionally_valid_tokens = [
                ...new Set([...unconditionallyValidTokens, ...deployedUnconditionallyValidAddresses])
            ];
            const newConfig = toml.stringify(feeTicker);
            fs.writeFileSync('./etc/env/dev/fee_ticker.toml', newConfig, 'utf-8');
            console.log('updated fee ticker config with', newConfig);
        }
        await utils.spawn('zk config compile');

        if (!process.env.CI) {
            await docker.restart('dev-ticker');
        }
    } else if (command == 'new') {
        await utils.spawn(
            `yarn --cwd contracts deploy-erc20 add --token-name ${name} --symbol ${symbol} --decimals ${decimals}`
        );
    }
}

export async function governanceAddERC20(command: 'dev' | 'new', address?: string) {
    if (command == 'dev') {
        await utils.spawn(`yarn --silent --cwd contracts governance-add-erc20 add-multi-current-network localhost`);
    } else if (command == 'new') {
        await utils.spawn(`yarn --cwd contracts governance-add-erc20 add ${address}`);
    }
}

export async function serverAddERC20(address: string, symbol: string, decimals: string) {
    await utils.spawn(
        `yarn --cwd contracts server-add-erc20 add --address ${address} --symbol ${symbol} --decimals ${decimals}`
    );
}

export async function serverAddERC20AndMint(name: string, symbol: string, decimals: string, net: string) {
    await utils.spawn(
        `yarn --cwd contracts server-add-erc20 add-and-mint --sname ${name} --symbol ${symbol} --decimals ${decimals} --env ${net}`
    );
}

export async function tokenInfo(address: string) {
    await utils.spawn(`yarn --cwd contracts token-info info ${address}`);
}

// installs all dependencies and builds our js packages
export async function yarn(crypto: boolean) {
    await utils.spawn('yarn');
    if (crypto) {
        await utils.spawn('yarn build:crypto');
    }

    await utils.spawn('yarn build:reading-tool');
}

export async function deployTestkit(genesisRoot: string, prodContracts: boolean = false) {
    const option = prodContracts ? '--prodContracts' : '';
    await utils.spawn(`yarn contracts deploy-testkit --genesisRoot ${genesisRoot} ${option}`);
}

export async function deployEIP1271() {
    await utils.spawn(`yarn contracts deploy-eip1271`);
}

export async function deployWithdrawalHelpersContracts() {
    await utils.spawn(`yarn contracts deploy-withdrawal-helpers-contracts`);
}

export async function testUpgrade(contract: string, gatekeeper: string) {
    await utils.spawn(`yarn contracts ts-node scripts/test-upgrade-franklin.ts ${contract} ${gatekeeper}`);
}

export async function plonkSetup(powers?: number[]) {
    if (!powers) {
        powers = [20, 21, 22, 23, 24, 25, 26];
    }
    const URL = 'https://universal-setup.ams3.digitaloceanspaces.com';
    fs.mkdirSync('keys/setup', { recursive: true });
    process.chdir('keys/setup');
    for (let power = 20; power <= 26; power++) {
        if (!fs.existsSync(`setup_2^${power}.key`)) {
            await utils.spawn(`axel -c ${URL}/setup_2%5E${power}.key`);
            await utils.sleep(1);
        }
    }
    process.chdir(process.env.ZKSYNC_HOME as string);
}

export async function revertReason(txHash: string, web3url?: string) {
    await utils.spawn(`yarn contracts ts-node scripts/revert-reason.ts ${txHash} ${web3url || ''}`);
}

export async function exitProof(...args: string[]) {
    await utils.spawn(`cargo run --example generate_exit_proof --release -- ${args.join(' ')}`);
}

export async function catLogs(exitCode?: number) {
    utils.allowFailSync(() => {
        console.log('\nSERVER LOGS:\n', fs.readFileSync('server.log').toString());
        console.log('\nPROVER LOGS:\n', fs.readFileSync('dummy_prover.log').toString());
    });
    if (exitCode !== undefined) {
        process.exit(exitCode);
    }
}

export async function testAccounts() {
    const testConfigPath = path.join(process.env.ZKSYNC_HOME as string, `etc/test_config/constant`);
    const ethTestConfig = JSON.parse(fs.readFileSync(`${testConfigPath}/eth.json`, { encoding: 'utf-8' }));
    const walletKeys = [];

    let ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow1_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow2_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow3_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow4_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow5_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    //ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow6_privK, 'hex'));
    //walletKeys.push({
    //    address: ethWallet.address,
    //    privateKey: ethWallet.privateKey
    //});
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow7_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow8_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });
    ethWallet = new Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow9_privK, 'hex'));
    walletKeys.push({
        address: ethWallet.address,
        privateKey: ethWallet.privateKey
    });

    console.log(JSON.stringify(walletKeys, null, 4));
}

export async function loadtest(...args: string[]) {
    console.log(args);
    await utils.spawn(`cargo run --release --bin loadnext -- ${args.join(' ')}`);
}

export async function readVariable(address: string, contractName: string, variableName: string, file?: string) {
    if (file === undefined)
        await utils.spawn(
            `yarn --silent --cwd contracts read-variable read ${address} ${contractName} ${variableName}`
        );
    else
        await utils.spawn(
            `yarn --silent --cwd contracts read-variable read ${address} ${contractName} ${variableName} -f ${file}`
        );
}

export const command = new Command('run')
    .description('run miscellaneous applications')
    .addCommand(verifyKeys.command)
    .addCommand(dataRestore.command)
    .addCommand(eventListener.command)
    .addCommand(walletGenerator.command)
    .addCommand(forcedExit.command);

command.command('test-accounts').description('print rootstock test accounts').action(testAccounts);
command
    .command('yarn')
    .description('install all JS dependencies')
    .option('--no-crypto', 'not include crypto packages')
    .action(async (cmd: Command) => {
        const { crypto } = cmd;
        await yarn(!!crypto);
    });
command.command('test-upgrade <main_contract> <gatekeeper_contract>').action(testUpgrade);
command.command('cat-logs [exit_code]').description('print server and prover logs').action(catLogs);

command
    .command('deploy-erc20 <dev|new> [name] [symbol] [decimals]')
    .description('deploy ERC20 tokens')
    .action(async (command: string, name?: string, symbol?: string, decimals?: string) => {
        if (command != 'dev' && command != 'new') {
            throw new Error('only "dev" and "new" subcommands are allowed');
        }
        await deployERC20(command, name, symbol, decimals);
    });

command
    .command('governance-add-erc20 <dev|new> [address]')
    .description('add testnet erc20 token to the governance')
    .action(async (command: string, address?: string) => {
        if (command != 'dev' && command != 'new') {
            throw new Error('only "dev" and "new" subcommands are allowed');
        }
        await governanceAddERC20(command, address);
    });

command
    .command('server-add-erc20 <address> <symbol> <decimals>')
    .description('add testnet erc20 token to the zkSynk server')
    .action(async (address: string, symbol: string, decimals: string) => {
        await utils.confirmAction();
        await serverAddERC20(address, symbol, decimals);
    });

command
    .command('server-add-erc20-and-mint <name> <symbol> <decimals> <net>')
    .description('add-and-mint testnet erc20 token to the zkSynk server')
    .action(async (name: string, symbol: string, decimals: string, net: string) => {
        await utils.confirmAction();
        await serverAddERC20AndMint(name, symbol, decimals, net);
    });

command
    .command('token-info <address>')
    .description('get symbol, name and decimals parameters from token')
    .action(async (address: string) => {
        await tokenInfo(address);
    });

command
    .command('plonk-setup [powers]')
    .description('download missing keys')
    .action(async (powers?: string) => {
        const powersArray = powers
            ?.split(' ')
            .map((x) => parseInt(x))
            .filter((x) => !Number.isNaN(x));
        await plonkSetup(powersArray);
    });

command
    .command('deploy-testkit')
    .description('deploy testkit contracts')
    .requiredOption('--genesisRoot <hash>')
    .option('--prodContracts')
    .action(async (cmd: Command) => {
        await deployTestkit(cmd.genesisRoot, cmd.prodContracts);
    });

command
    .command('deploy-eip1271')
    .description('deploy test EIP-1271 "smart wallet"')
    .action(async () => {
        await deployEIP1271();
    });

command
    .command('revert-reason <tx_hash> [web3_url]')
    .description('get the revert reason for rootstock transaction')
    .action(revertReason);

command
    .command('exit-proof')
    .option('--account <id>')
    .option('--token <id>')
    .option('--help')
    .description('generate exit proof')
    .action(async (cmd: Command) => {
        if (!cmd.account || !cmd.token) {
            await exitProof('--help');
        } else {
            await exitProof('--account_id', cmd.account, '--token', cmd.token);
        }
    });

command
    .command('loadtest [options...]')
    .description('run the loadtest')
    .allowUnknownOption()
    .action(async (options: string[]) => {
        await loadtest(...options);
    });

command
    .command('read-variable <address> <contractName> <variableName>')
    .option(
        '-f --file <file>',
        'file with contract source code(default $ZKSYNC_HOME/contracts/contracts/${contractName}.sol)'
    )
    .description('Read value of contract variable')
    .action(async (address: string, contractName: string, variableName: string, cmd: Command) => {
        await readVariable(address, contractName, variableName, cmd.file);
    });
