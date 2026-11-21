// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {QPulseBilling} from "../src/QPulseBilling.sol";
import {PulseAttestations} from "../src/PulseAttestations.sol";

/// Deploy both contracts and give the attester its gas, with one signature prompt:
///   TREASURY=0x… ATTESTER=0x… forge script script/DeployAll.s.sol --rpc-url qie --broadcast --account <keystore-name>
/// Optional: ATTESTER_FUNDING (wei, default 0.05 QIE), BILLING_TOKEN, PRO_PRICE_UNITS, PRO_PERIOD_SECONDS.
contract DeployAll is Script {
    address constant QUSDC = 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5;

    function run() external returns (QPulseBilling billing, PulseAttestations att) {
        address token = vm.envOr("BILLING_TOKEN", QUSDC);
        address treasury = vm.envAddress("TREASURY");
        address attester = vm.envAddress("ATTESTER");
        uint256 price = vm.envOr("PRO_PRICE_UNITS", uint256(9e6));
        uint32 duration = uint32(vm.envOr("PRO_PERIOD_SECONDS", uint256(30 days)));
        uint256 funding = vm.envOr("ATTESTER_FUNDING", uint256(0.05 ether));
        require(attester != treasury, "attester must be its own hot wallet, not the treasury");

        vm.startBroadcast();
        billing = new QPulseBilling(token, treasury, price, duration);
        att = new PulseAttestations(attester);
        if (funding > 0) {
            (bool ok,) = payable(attester).call{value: funding}("");
            require(ok, "funding the attester failed");
        }
        vm.stopBroadcast();

        console.log("QPulseBilling deployed at", address(billing));
        console.log("PulseAttestations deployed at", address(att));
        console.log("Attester funded with (wei)", funding);
    }
}
