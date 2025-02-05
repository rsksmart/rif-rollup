import { deployContract } from 'ethereum-waffle';
import fs from 'fs';
import { Tester } from './tester';
import { Signer, utils } from 'ethers';
import { expect } from 'chai';
import { Wallet, types, RBTCProxy, utils as zkutils } from '@rsksmart/rif-rollup-js-sdk';
type TokenLike = types.TokenLike;

function readContractCode(name: string) {
    const fileName = name.split('/').pop();
    return JSON.parse(
        fs.readFileSync(
            `${process.env['ZKSYNC_HOME']}/contracts/artifacts/cache/solpp-generated-contracts/${name}.sol/${fileName}.json`,
            {
                encoding: 'utf-8'
            }
        )
    );
}
function readFactoryCode() {
    return readContractCode('ZkSyncNFTCustomFactory');
}

declare module './tester' {
    interface Tester {
        testRegisterFactory(wallet: Wallet, withdrawer: Signer, feeToken: TokenLike): Promise<void>;
    }
}

Tester.prototype.testRegisterFactory = async function (wallet: Wallet, withdrawer: Signer, feeToken: TokenLike) {
    const contractAddress = await wallet.provider.getContractAddress();
    const rbtcProxy = new RBTCProxy(wallet.ethSigner().provider!, contractAddress);
    const defaultNFTFactoryAddress = (await rbtcProxy.getGovernanceContract().defaultFactory()).toLowerCase();

    const type = 'MintNFT';
    const contentHash = utils.randomBytes(32);
    let { totalFee: fee } = await this.syncProvider.getTransactionFee(type, wallet.address(), feeToken);

    const handle = await wallet.mintNFT({
        recipient: wallet.address(),
        contentHash,
        feeToken,
        fee
    });

    this.runningFee = this.runningFee.add(fee);
    const receipt = await handle.awaitVerifyReceipt();
    expect(receipt.success, `Mint NFT failed with a reason: ${receipt.failReason}`).to.be.true;

    const state = await wallet.getAccountState();
    const nft: any = Object.values(state.verified.nfts)[0];

    let nftInfo = await wallet.provider.getNFT(nft.id);
    expect(nftInfo.currentFactory, 'NFT info before withdrawing is wrong').to.eql(defaultNFTFactoryAddress);
    expect(nftInfo.withdrawnFactory, 'NFT info before withdrawing is wrong').to.be.null;

    const contract = await deployContract(
        wallet.ethSigner(),
        readFactoryCode(),
        [
            'TestFactory',
            'TS',
            wallet.provider.contractAddress.mainContract,
            wallet.provider.contractAddress.govContract
        ],
        {
            gasLimit: 5000000
        }
    );
    const { signature, accountId, accountAddress } = await wallet.signRegisterFactory(contract.address);
    const tx = await contract.registerNFTFactory(accountId, accountAddress, signature.signature, {
        gasLimit: 5000000
    });
    await tx.wait();

    // Wait until the server processes the new factory.
    const processingIntervalSeconds = parseInt(process.env.TOKEN_HANDLER_POLL_INTERVAL || '1');
    await zkutils.sleep(processingIntervalSeconds * 1000);

    let { totalFee: withdrawFee } = await this.syncProvider.getTransactionFee(
        'WithdrawNFT',
        wallet.address(),
        feeToken
    );
    const handleWithdraw = await wallet.withdrawNFT({
        to: wallet.address(),
        token: nft.id,
        feeToken,
        fee: withdrawFee
    });
    const receiptWithdraw = await handleWithdraw.awaitVerifyReceipt();
    expect(receiptWithdraw.success, `Withdraw NFT failed with a reason: ${receiptWithdraw.failReason}`).to.be.true;
    const withdrawPendingNFTBalanceTrx = await rbtcProxy
        .getRifRollupContract()
        .connect(withdrawer)
        .withdrawPendingNFTBalance(nft.id);
    await withdrawPendingNFTBalanceTrx.wait();

    const owner = await contract.ownerOf(nft.id);
    expect(owner == wallet.address(), 'Contract minting is wrong');
    this.runningFee = this.runningFee.add(withdrawFee);

    nftInfo = await wallet.provider.getNFT(nft.id);
    expect(nftInfo.currentFactory, 'NFT info after withdrawing is wrong (current factory)').to.eql(
        contract.address.toLowerCase()
    );
    expect(nftInfo.withdrawnFactory, 'NFT info after withdrawing is wrong (withdrawn factory)').to.eql(
        contract.address.toLowerCase()
    );
};
