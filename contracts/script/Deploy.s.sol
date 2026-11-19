// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {QPulseBilling} from "../src/QPulseBilling.sol";

/// Deploy to QIE mainnet:
///   TREASURY=0xYourSafe forge script script/Deploy.s.sol --rpc-url qie --broadcast --account <keystore-name>
/// Defaults: official QUSDC (0x3F43…5DA5), 9 QUSDC per 30 days.
contract Deploy is Script {
    address constant QUSDC = 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5;

    function run() external returns (QPulseBilling billing) {
        address token = vm.envOr("BILLING_TOKEN", QUSDC);
        address treasury = vm.envAddress("TREASURY");
        uint256 price = vm.envOr("PRO_PRICE_UNITS", uint256(9e6));
        uint32 duration = uint32(vm.envOr("PRO_PERIOD_SECONDS", uint256(30 days)));

        vm.startBroadcast();
        billing = new QPulseBilling(token, treasury, price, duration);
        vm.stopBroadcast();

        console.log("QPulseBilling deployed at", address(billing));
        console.log("Set BILLING_CONTRACT and BILLING_START_BLOCK in the server env.");
    }
}
