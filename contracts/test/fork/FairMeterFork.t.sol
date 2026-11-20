// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FairMeter} from "../../src/FairMeter.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8x is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
}

/// @notice FairMeter against the REAL tUSD8 on a local fork of Aevum testnet (permit, EIP-3009, settle, revoke).
///         Run with: make test-fork
contract FairMeterForkTest is Test {
    ITUSD8x constant TUSD8 = ITUSD8x(0x456569838f1d43009A91ebA4263147Afd7233483);
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    FairMeter meter;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address provider = makeAddr("provider");

    function setUp() public {
        meter = new FairMeter(TUSD8);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        deal(address(TUSD8), owner, 10e6);
    }

    function _usage(uint256 id, bytes32 req, uint256 maxPrice, uint64 dl) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, meter.usageDigest(id, req, maxPrice, dl));
        return abi.encodePacked(r, s, v);
    }

    function test_realTusd8_permitOpenSettleRevoke() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(meter), 5e6, TUSD8.nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", TUSD8.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(owner);
        uint256 id = meter.openWithPermit(agent, provider, 5e6, 5e6, 1e6, uint64(block.timestamp + 1 days), deadline, v, r, s);

        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _usage(id, "q1", 0.8e6, dl); // sign first: an external call here would eat the prank
        vm.prank(provider);
        meter.settle(id, "q1", 0.8e6, dl, 0.05e6, keccak256("receipt"), sig);
        assertEq(TUSD8.balanceOf(provider), 0.05e6);

        vm.prank(owner);
        meter.revoke(id);
        assertEq(TUSD8.balanceOf(owner), 10e6 - 0.05e6);
        assertEq(TUSD8.balanceOf(address(meter)), 0);
    }

    function test_realTusd8_gaslessOpen() public {
        FairMeter.Terms memory t =
            FairMeter.Terms(owner, agent, provider, 3e6, 3e6, 1e6, uint64(block.timestamp + 1 days), keccak256("x"));
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            ownerKey,
            TUSD8.DOMAIN_SEPARATOR(),
            Signing.Auth(owner, address(meter), 3e6, 0, block.timestamp + 1 hours, meter.openNonce(t))
        );
        vm.prank(makeAddr("relayer"));
        uint256 id = meter.openWithAuthorization(t, FairMeter.Auth3009(0, block.timestamp + 1 hours, v, r, s));
        assertEq(meter.mandateOf(id).balance, 3e6);
        assertEq(TUSD8.balanceOf(address(meter)), 3e6);
    }
}
