// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PulseAttestations} from "../src/PulseAttestations.sol";

/// Replace the attester key (e.g. it leaked or was lost) and give the new one its gas, with one
/// signature from the contract owner:
///   ATTESTATIONS=0x… NEW_ATTESTER=0x… forge script script/RotateAttester.s.sol --rpc-url qie --broadcast --account <owner-keystore>
/// Optional: ATTESTER_FUNDING (wei, default 0.05 QIE).
contract RotateAttester is Script {
    function run() external {
        PulseAttestations att = PulseAttestations(vm.envAddress("ATTESTATIONS"));
        address next = vm.envAddress("NEW_ATTESTER");
        uint256 funding = vm.envOr("ATTESTER_FUNDING", uint256(0.05 ether));
        require(next != att.attester(), "already the attester");

        vm.startBroadcast();
        att.setAttester(next);
        if (funding > 0) {
            (bool ok,) = payable(next).call{value: funding}("");
            require(ok, "funding the attester failed");
        }
        vm.stopBroadcast();

        console.log("Attester is now", att.attester());
        console.log("Funded with (wei)", funding);
    }
}
