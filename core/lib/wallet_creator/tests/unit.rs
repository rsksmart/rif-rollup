use zksync::web3::types::{H160, H256};

use rif_rollup_wallet_generator_lib::eth_random_account_credentials;

#[cfg(test)]
mod tests {
    // Note this useful idiom: importing names from outer (for mod tests) scope.
    use super::*;

    #[test]
    fn test_generate_random_keys() {
        let eth_address: H160;
        let eth_private_key: H256;
        (eth_address, eth_private_key) = eth_random_account_credentials();

        println!("-> Address {:?}", eth_address);
        println!("-> Private key {:?}", eth_private_key);

        assert!(!eth_address.is_zero());
        assert!(!eth_private_key.is_zero());
    }
}
