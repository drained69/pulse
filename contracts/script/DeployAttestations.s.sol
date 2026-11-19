// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PulseAttestations} from "../src/PulseAttestations.sol";

/// Deploy to QIE mainnet:
///   ATTESTER=0xServerHotWallet forge script script/DeployAttestations.s.sol --rpc-url qie --broadcast --account <keystore-name>
/// ATTESTER is the address of the server's attestation key (it only needs a little QIE for gas).
/// The deployer becomes the owner and can rotate the attester later.
contract DeployAttestations is Script {
    function run() external returns (PulseAttestations att) {
        address attester = vm.envAddress("ATTESTER");
        vm.startBroadcast();
        att = new PulseAttestations(attester);
        vm.stopBroadcast();
        console.log("PulseAttestations deployed at", address(att));
        console.log("Set ATTESTATION_CONTRACT on the server, and ATTESTER_PRIVATE_KEY for the attester key.");
    }
}
