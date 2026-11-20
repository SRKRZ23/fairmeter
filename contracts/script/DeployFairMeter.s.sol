// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FairMeter} from "../src/FairMeter.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Deploy FairMeter. On Aevum (44005) and its local fork (440050) it uses the real tUSD8; on an empty
///         local anvil chain (31337) it first deploys MockUSD8 (same decimals, EIP-712 domain and EIP-3009).
///   make deploy-aevum ACCOUNT=<keystore>   |   make deploy-fork   |   make deploy-local
contract DeployFairMeter is Script {
    address constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (FairMeter meter) {
        vm.startBroadcast();
        address token = TUSD8;
        if (block.chainid == 31337) {
            token = address(new MockUSD8());
            console.log("MockUSD8:", token);
        } else {
            require(block.chainid == 44005 || block.chainid == 440050, "Aevum, its fork, or local anvil only");
        }
        meter = new FairMeter(IERC20(token));
        vm.stopBroadcast();
        console.log("FairMeter:", address(meter));
        console.log("block:", block.number);
    }
}
