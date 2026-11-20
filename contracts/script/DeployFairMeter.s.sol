// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FairMeter} from "../src/FairMeter.sol";

/// @notice Deploy FairMeter for tUSD8 on Aevum testnet (44005).
///   forge script script/DeployFairMeter.s.sol --rpc-url aevum --broadcast --legacy --account <keystore>
contract DeployFairMeter is Script {
    address constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (FairMeter meter) {
        require(block.chainid == 44005 || block.chainid == 440050, "Aevum or its local fork only");
        vm.startBroadcast();
        meter = new FairMeter(IERC20(TUSD8));
        vm.stopBroadcast();
        console.log("FairMeter:", address(meter));
        console.log("block:", block.number);
    }
}
