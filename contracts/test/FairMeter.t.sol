// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FairMeter} from "../src/FairMeter.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

/// @dev A minimal smart account: accepts signatures from one session key (ERC-1271).
contract SessionKeyAccount is IERC1271 {
    address public sessionKey;

    constructor(address k) {
        sessionKey = k;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address got,,) = ECDSA.tryRecover(hash, sig);
        return got == sessionKey ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract FairMeterTest is Test {
    MockUSD8 token;
    FairMeter meter;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address provider = makeAddr("provider");
    address thief = makeAddr("thief");

    uint256 constant FUND = 10e6; // 10 tUSD8
    uint256 constant CAP = 8e6;
    uint256 constant PER_REQ = 1e6;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        meter = new FairMeter(IERC20(address(token)));
        token.mint(owner, 100e6);
        vm.warp(1_800_000_000);
    }

    // ---------- helpers ----------

    function _open() internal returns (uint256 id) {
        vm.startPrank(owner);
        token.approve(address(meter), FUND);
        id = meter.open(agent, provider, FUND, CAP, PER_REQ, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _sig(uint256 key, uint256 id, bytes32 req, uint256 maxPrice, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, meter.usageDigest(id, req, maxPrice, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _settle(uint256 id, bytes32 req, uint256 maxPrice, uint256 charge) internal {
        uint64 dl = uint64(block.timestamp + 10 minutes);
        bytes memory sig = _sig(agentKey, id, req, maxPrice, dl);
        vm.prank(provider);
        meter.settle(id, req, maxPrice, dl, charge, keccak256("receipt"), sig);
    }

    // ---------- opening ----------

    function test_open_locksFunds() public {
        uint256 id = _open();
        FairMeter.Mandate memory m = meter.mandateOf(id);
        assertEq(m.owner, owner);
        assertEq(m.agent, agent);
        assertEq(m.provider, provider);
        assertEq(m.balance, FUND);
        assertEq(token.balanceOf(address(meter)), FUND);
        assertEq(meter.spendable(id), CAP); // cap is lower than the balance
    }

    function test_open_rejectsBadTerms() public {
        vm.startPrank(owner);
        token.approve(address(meter), FUND);
        vm.expectRevert(FairMeter.BadTerms.selector); // per-request above cap
        meter.open(agent, provider, FUND, 1e6, 2e6, uint64(block.timestamp + 1));
        vm.expectRevert(FairMeter.BadTerms.selector); // already expired
        meter.open(agent, provider, FUND, CAP, PER_REQ, uint64(block.timestamp));
        vm.expectRevert(FairMeter.ZeroAddress.selector);
        meter.open(address(0), provider, FUND, CAP, PER_REQ, uint64(block.timestamp + 1));
        vm.expectRevert(FairMeter.ZeroAmount.selector);
        meter.open(agent, provider, 0, CAP, PER_REQ, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function test_openWithAuthorization_gasless() public {
        bytes32 salt = keccak256("s1");
        uint64 exp = uint64(block.timestamp + 1 days);
        FairMeter.Terms memory t = FairMeter.Terms(owner, agent, provider, FUND, CAP, PER_REQ, exp, salt);
        bytes32 nonce = meter.openNonce(t);
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            ownerKey,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth(owner, address(meter), FUND, 0, block.timestamp + 1 hours, nonce)
        );
        vm.prank(makeAddr("relayer"));
        uint256 id = meter.openWithAuthorization(t, FairMeter.Auth3009(0, block.timestamp + 1 hours, v, r, s));
        assertEq(meter.mandateOf(id).owner, owner);
        assertEq(token.balanceOf(address(meter)), FUND);
    }

    function test_openWithAuthorization_relayerCannotChangeTerms() public {
        bytes32 salt = keccak256("s1");
        uint64 exp = uint64(block.timestamp + 1 days);
        FairMeter.Terms memory t = FairMeter.Terms(owner, agent, provider, FUND, CAP, PER_REQ, exp, salt);
        bytes32 nonce = meter.openNonce(t);
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            ownerKey,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth(owner, address(meter), FUND, 0, block.timestamp + 1 hours, nonce)
        );
        // The relayer swaps in its own agent key: the nonce no longer matches, the token rejects the signature.
        t.agent = thief;
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        meter.openWithAuthorization(t, FairMeter.Auth3009(0, block.timestamp + 1 hours, v, r, s));
    }

    // ---------- settlement ----------

    function test_settle_chargesActualNotMax() public {
        uint256 id = _open();
        _settle(id, "r1", 0.5e6, 0.12e6); // agent allowed 0.50, provider used 0.12
        assertEq(token.balanceOf(provider), 0.12e6);
        FairMeter.Mandate memory m = meter.mandateOf(id);
        assertEq(m.spent, 0.12e6);
        assertEq(m.balance, FUND - 0.12e6);
        assertEq(m.requests, 1);
    }

    function test_settle_emitsReceipt() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.expectEmit(true, true, false, true, address(meter));
        emit FairMeter.Settled(id, "r1", 0.5e6, 0.2e6, keccak256("rc"));
        vm.prank(provider);
        meter.settle(id, "r1", 0.5e6, dl, 0.2e6, keccak256("rc"), sig);
    }

    function test_settle_rejectsOverMaxPrice() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.OverMaxPrice));
        meter.settle(id, "r1", 0.5e6, dl, 0.51e6, bytes32(0), sig);
    }

    function test_settle_rejectsRaisedMaxPrice() public {
        // The provider claims the agent allowed more than it signed: signature check fails.
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.1e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.BadSignature));
        meter.settle(id, "r1", 0.9e6, dl, 0.9e6, bytes32(0), sig);
    }

    function test_settle_onceOnly() public {
        uint256 id = _open();
        _settle(id, "r1", 0.5e6, 0.1e6);
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.AlreadySettled));
        meter.settle(id, "r1", 0.5e6, dl, 0.1e6, bytes32(0), sig);
    }

    function test_settle_onlyProvider() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.NotProvider));
        meter.settle(id, "r1", 0.5e6, dl, 0.5e6, bytes32(0), sig);
    }

    function test_settle_perRequestMax() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 2e6, dl);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.OverPerRequestMax)
        );
        meter.settle(id, "r1", 2e6, dl, 1.5e6, bytes32(0), sig);
    }

    function test_settle_capStopsRunawaySpending() public {
        uint256 id = _open();
        for (uint256 i; i < 8; ++i) {
            _settle(id, bytes32(i + 1), 1e6, 1e6);
        }
        assertEq(meter.spendable(id), 0);
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r9", 1e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.OverCap));
        meter.settle(id, "r9", 1e6, dl, 1e6, bytes32(0), sig);
    }

    function test_settle_pastDeadline() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.warp(dl + 1);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.PastDeadline));
        meter.settle(id, "r1", 0.5e6, dl, 0.5e6, bytes32(0), sig);
    }

    function test_settle_signatureBoundToMandate() public {
        uint256 id1 = _open();
        uint256 id2 = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id1, "r1", 0.5e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.BadSignature));
        meter.settle(id2, "r1", 0.5e6, dl, 0.5e6, bytes32(0), sig);
    }

    // ---------- stolen agent key ----------

    function test_stolenAgentKey_cannotPayAnyoneElse() public {
        uint256 id = _open();
        // The thief has the agent key and signs freely, but only the provider can settle,
        // and the money only ever moves to the provider or back to the owner.
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "steal", 1e6, dl);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.NotProvider));
        meter.settle(id, "steal", 1e6, dl, 1e6, bytes32(0), sig);
        assertEq(token.balanceOf(thief), 0);
    }

    function test_rotateAgent_oldKeyStops() public {
        uint256 id = _open();
        (address agent2, uint256 agent2Key) = makeAddrAndKey("agent2");
        vm.prank(owner);
        meter.setAgent(id, agent2);
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory oldSig = _sig(agentKey, id, "r1", 0.5e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.BadSignature));
        meter.settle(id, "r1", 0.5e6, dl, 0.5e6, bytes32(0), oldSig);
        bytes memory newSig = _sig(agent2Key, id, "r1", 0.5e6, dl);
        vm.prank(provider);
        meter.settle(id, "r1", 0.5e6, dl, 0.5e6, bytes32(0), newSig);
    }

    function test_setAgent_onlyOwner() public {
        uint256 id = _open();
        vm.prank(thief);
        vm.expectRevert(FairMeter.NotOwner.selector);
        meter.setAgent(id, thief);
    }

    // ---------- revoke and expiry ----------

    function test_revoke_refundsAndBlocksEarlierSignatures() public {
        uint256 id = _open();
        _settle(id, "r1", 1e6, 0.3e6);
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory pending = _sig(agentKey, id, "r2", 1e6, dl); // signed before revoke
        uint256 before = token.balanceOf(owner);
        vm.prank(owner);
        meter.revoke(id);
        assertEq(token.balanceOf(owner) - before, FUND - 0.3e6);
        assertEq(meter.spendable(id), 0);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.Revoked));
        meter.settle(id, "r2", 1e6, dl, 1e6, bytes32(0), pending);
    }

    function test_revoke_onlyOwnerAndOnce() public {
        uint256 id = _open();
        vm.prank(thief);
        vm.expectRevert(FairMeter.NotOwner.selector);
        meter.revoke(id);
        vm.prank(owner);
        meter.revoke(id);
        vm.prank(owner);
        vm.expectRevert(FairMeter.MandateClosed.selector);
        meter.revoke(id);
    }

    function test_expiry_blocksAndRefunds() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(meter.spendable(id), 0);
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "late", 0.5e6, dl);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(FairMeter.SettlementFailed.selector, FairMeter.Status.Expired));
        meter.settle(id, "late", 0.5e6, dl, 0.5e6, bytes32(0), sig);
        uint256 before = token.balanceOf(owner);
        vm.prank(thief); // anyone may trigger it, the money goes to the owner
        meter.closeExpired(id);
        assertEq(token.balanceOf(owner) - before, FUND);
        assertEq(token.balanceOf(thief), 0);
    }

    function test_closeExpired_notBeforeExpiry() public {
        uint256 id = _open();
        vm.expectRevert(FairMeter.BadTerms.selector);
        meter.closeExpired(id);
    }

    function test_topUp() public {
        uint256 id = _open();
        vm.startPrank(owner);
        token.approve(address(meter), 2e6);
        meter.topUp(id, 2e6);
        vm.stopPrank();
        assertEq(meter.mandateOf(id).balance, FUND + 2e6);
    }

    // ---------- batch ----------

    function test_batch_skipsBadItemsAndSettlesRest() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        FairMeter.Settlement[] memory items = new FairMeter.Settlement[](3);
        items[0] = FairMeter.Settlement(id, "a", 0.5e6, dl, 0.2e6, bytes32("ra"), _sig(agentKey, id, "a", 0.5e6, dl));
        items[1] = FairMeter.Settlement(id, "b", 0.5e6, dl, 0.9e6, bytes32("rb"), _sig(agentKey, id, "b", 0.5e6, dl)); // over max
        items[2] = FairMeter.Settlement(id, "c", 0.5e6, dl, 0.3e6, bytes32("rc"), _sig(agentKey, id, "c", 0.5e6, dl));
        vm.prank(provider);
        (FairMeter.Status[] memory st, uint256 total) = meter.settleBatch(items);
        assertEq(uint256(st[0]), uint256(FairMeter.Status.Ok));
        assertEq(uint256(st[1]), uint256(FairMeter.Status.OverMaxPrice));
        assertEq(uint256(st[2]), uint256(FairMeter.Status.Ok));
        assertEq(total, 0.5e6);
        assertEq(token.balanceOf(provider), 0.5e6);
        assertFalse(meter.settled(id, "b"));
    }

    function test_check_matchesSettle() public {
        uint256 id = _open();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(agentKey, id, "r1", 0.5e6, dl);
        assertEq(uint256(meter.check(id, "r1", 0.5e6, dl, 0.4e6, provider, sig)), uint256(FairMeter.Status.Ok));
        assertEq(
            uint256(meter.check(id, "r1", 0.5e6, dl, 0.4e6, thief, sig)), uint256(FairMeter.Status.NotProvider)
        );
    }

    // ---------- smart-account agents (ERC-1271 session keys) ----------

    function test_smartAccountAgent_sessionKey() public {
        (address sk, uint256 skKey) = makeAddrAndKey("session");
        SessionKeyAccount acct = new SessionKeyAccount(sk);
        vm.startPrank(owner);
        token.approve(address(meter), FUND);
        uint256 id = meter.open(address(acct), provider, FUND, CAP, PER_REQ, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        uint64 dl = uint64(block.timestamp + 60);
        bytes memory sig = _sig(skKey, id, "r1", 0.5e6, dl);
        vm.prank(provider);
        meter.settle(id, "r1", 0.5e6, dl, 0.25e6, bytes32(0), sig);
        assertEq(token.balanceOf(provider), 0.25e6);
    }

    // ---------- receipt key ----------

    function test_receiptKey() public {
        bytes memory pk = new bytes(1952);
        pk[0] = 0x42;
        vm.prank(provider);
        meter.setReceiptKey(pk);
        assertEq(meter.receiptKeyHash(provider), keccak256(pk));
    }

    // ---------- fuzz: money is conserved and never exceeds the caps ----------

    function testFuzz_conservation(uint96 maxPrice, uint96 charge, uint8 n) public {
        uint256 id = _open();
        n = uint8(bound(n, 1, 20));
        uint256 paid;
        for (uint256 i; i < n; ++i) {
            uint64 dl = uint64(block.timestamp + 60);
            bytes32 req = bytes32(i + 1);
            bytes memory sig = _sig(agentKey, id, req, maxPrice, dl);
            vm.prank(provider);
            try meter.settle(id, req, maxPrice, dl, charge, bytes32(0), sig) {
                paid += charge;
            } catch {}
        }
        FairMeter.Mandate memory m = meter.mandateOf(id);
        assertEq(token.balanceOf(provider), paid);
        assertEq(m.spent, paid);
        assertEq(uint256(m.balance) + m.spent, FUND);
        assertLe(m.spent, CAP);
        assertEq(token.balanceOf(address(meter)), m.balance);
    }
}
