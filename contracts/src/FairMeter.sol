// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice EIP-2612 permit. tUSD8 on Aevum implements this.
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title FairMeter
/// @notice Pay-per-request settlement for AI and other metered services, in a stablecoin.
///
/// An owner funds a *mandate*: money locked for one provider, spendable only by one agent key, with a total cap,
/// a per-request maximum and an expiry. For every request the agent signs a `Usage` authorization that names the
/// most it is willing to pay (`maxPrice`). After serving the request the provider settles the *actual* cost,
/// which can be lower, and commits a hash of its signed usage receipt. Whatever is not charged stays in the
/// mandate. The owner can revoke at any time and gets the unspent balance back in the same transaction.
///
/// Safety properties (each one is a test in FairMeter.t.sol):
///  - A stolen agent key can only pay the mandate's provider, within the caps, until expiry or revocation.
///  - The provider can never charge more than the agent signed for, and each request settles at most once.
///  - Agent keys can be EOAs or smart accounts (ERC-1271), so session keys from a smart wallet work unchanged.
contract FairMeter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Mandate {
        address owner;
        address agent;
        address provider;
        uint64 expiresAt;
        bool revoked;
        uint128 balance; // locked and not yet charged
        uint128 spent; // charged so far
        uint128 cap; // the most this mandate can ever be charged in total
        uint128 perRequestMax; // the most a single request can be charged
        uint32 requests; // settled requests
    }

    /// @dev One item of a batch settlement.
    struct Settlement {
        uint256 mandateId;
        bytes32 requestId;
        uint256 maxPrice;
        uint64 deadline;
        uint256 charge;
        bytes32 receiptHash;
        bytes agentSig;
    }

    /// @notice Settlement outcome codes, emitted for skipped batch items.
    enum Status {
        Ok,
        UnknownMandate,
        NotProvider,
        Revoked,
        Expired,
        PastDeadline,
        AlreadySettled,
        OverMaxPrice,
        OverPerRequestMax,
        OverCap,
        OverBalance,
        BadSignature
    }

    bytes32 public constant USAGE_TYPEHASH =
        keccak256("Usage(uint256 mandateId,bytes32 requestId,uint256 maxPrice,uint64 deadline)");

    IERC20 public immutable token;

    uint256 public nextMandateId = 1;
    mapping(uint256 mandateId => Mandate) private _mandates;
    mapping(uint256 mandateId => mapping(bytes32 requestId => bool)) public settled;

    /// @notice Providers can publish the hash of their post-quantum (ML-DSA-65) receipt-signing key, so anyone
    ///         can check that an off-chain receipt was signed by the key the provider committed to on-chain.
    mapping(address provider => bytes32) public receiptKeyHash;

    event MandateOpened(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed provider,
        address agent,
        uint256 amount,
        uint256 cap,
        uint256 perRequestMax,
        uint64 expiresAt
    );
    event ToppedUp(uint256 indexed mandateId, uint256 amount);
    event AgentChanged(uint256 indexed mandateId, address agent);
    event Settled(
        uint256 indexed mandateId,
        bytes32 indexed requestId,
        uint256 maxPrice,
        uint256 charge,
        bytes32 receiptHash
    );
    event SettlementSkipped(uint256 indexed mandateId, bytes32 indexed requestId, Status status);
    event Closed(uint256 indexed mandateId, uint256 refund, bool revoked);
    event ReceiptKeySet(address indexed provider, bytes32 keyHash, bytes publicKey);

    error ZeroAddress();
    error ZeroAmount();
    error BadTerms();
    error NotOwner();
    error MandateClosed();
    error SettlementFailed(Status status);

    constructor(IERC20 token_) EIP712("FairMeter", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Opening and funding
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Open a mandate with tokens already approved to this contract.
    function open(
        address agent,
        address provider,
        uint256 amount,
        uint256 cap,
        uint256 perRequestMax,
        uint64 expiresAt
    ) external nonReentrant returns (uint256 mandateId) {
        mandateId = _open(msg.sender, agent, provider, amount, cap, perRequestMax, expiresAt);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Open a mandate in one transaction with an EIP-2612 permit instead of a separate approve.
    function openWithPermit(
        address agent,
        address provider,
        uint256 amount,
        uint256 cap,
        uint256 perRequestMax,
        uint64 expiresAt,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 mandateId) {
        // A permit can be front-run (someone submits it first); the allowance is then already there,
        // so a failed permit is fine as long as the transfer below succeeds.
        try IERC2612(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
        mandateId = _open(msg.sender, agent, provider, amount, cap, perRequestMax, expiresAt);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice The terms of a mandate opened through `openWithAuthorization`.
    struct Terms {
        address owner;
        address agent;
        address provider;
        uint256 amount;
        uint256 cap;
        uint256 perRequestMax;
        uint64 expiresAt;
        bytes32 salt;
    }

    /// @notice An EIP-3009 `ReceiveWithAuthorization` signature (validity window + v, r, s).
    struct Auth3009 {
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Open a mandate with one off-chain EIP-3009 signature from the owner; anyone (a relayer) can submit
    ///         it, so the owner needs no gas. The signed nonce must be `openNonce(t)`, which binds the signature to
    ///         these exact terms: a relayer cannot change the agent, provider, caps or expiry.
    function openWithAuthorization(Terms calldata t, Auth3009 calldata a) external nonReentrant returns (uint256 mandateId) {
        mandateId = _open(t.owner, t.agent, t.provider, t.amount, t.cap, t.perRequestMax, t.expiresAt);
        IERC3009(address(token)).receiveWithAuthorization(
            t.owner, address(this), t.amount, a.validAfter, a.validBefore, openNonce(t), a.v, a.r, a.s
        );
    }

    /// @notice The EIP-3009 nonce an owner signs to open a mandate through `openWithAuthorization`.
    function openNonce(Terms calldata t) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), t));
    }

    /// @notice Add money to an open mandate. Anyone can top up; only the owner can take money out.
    function topUp(uint256 mandateId, uint256 amount) external nonReentrant {
        Mandate storage m = _live(mandateId);
        if (amount == 0) revert ZeroAmount();
        m.balance += _u128(amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ToppedUp(mandateId, amount);
    }

    /// @notice Rotate the agent key (for example after a suspected leak). Signatures by the old key stop working.
    function setAgent(uint256 mandateId, address agent) external {
        Mandate storage m = _ownedLive(mandateId);
        if (agent == address(0)) revert ZeroAddress();
        m.agent = agent;
        emit AgentChanged(mandateId, agent);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Settlement
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Charge one request. Only the mandate's provider can call this. Reverts with the reason on failure.
    function settle(
        uint256 mandateId,
        bytes32 requestId,
        uint256 maxPrice,
        uint64 deadline,
        uint256 charge,
        bytes32 receiptHash,
        bytes calldata agentSig
    ) external nonReentrant {
        Status st = _settle(mandateId, requestId, maxPrice, deadline, charge, receiptHash, agentSig);
        if (st != Status.Ok) revert SettlementFailed(st);
    }

    /// @notice Charge many requests in one transaction. A bad item is skipped (with a `SettlementSkipped` event and
    ///         its status in the return array) instead of blocking the rest. Returns the total charged.
    function settleBatch(Settlement[] calldata items) external nonReentrant returns (Status[] memory statuses, uint256 total) {
        statuses = new Status[](items.length);
        for (uint256 i; i < items.length; ++i) {
            Settlement calldata it = items[i];
            Status st = _settle(it.mandateId, it.requestId, it.maxPrice, it.deadline, it.charge, it.receiptHash, it.agentSig);
            statuses[i] = st;
            if (st == Status.Ok) total += it.charge;
            else emit SettlementSkipped(it.mandateId, it.requestId, st);
        }
    }

    /// @notice Dry-run a settlement: the status `settle` would produce now, without changing state.
    function check(
        uint256 mandateId,
        bytes32 requestId,
        uint256 maxPrice,
        uint64 deadline,
        uint256 charge,
        address caller,
        bytes calldata agentSig
    ) external view returns (Status) {
        return _check(mandateId, requestId, maxPrice, deadline, charge, caller, agentSig);
    }

    /// @notice The EIP-712 digest an agent signs to authorize one request.
    function usageDigest(uint256 mandateId, bytes32 requestId, uint256 maxPrice, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(USAGE_TYPEHASH, mandateId, requestId, maxPrice, deadline)));
    }

    // ----------------------------------------------------------------------------------------------------------
    // Closing
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Owner stops the mandate now and takes back everything not yet charged. Effective immediately:
    ///         no later settlement succeeds, including for authorizations signed earlier.
    function revoke(uint256 mandateId) external nonReentrant {
        Mandate storage m = _ownedLive(mandateId);
        m.revoked = true;
        _refund(mandateId, m, true);
    }

    /// @notice After expiry, return the unspent balance to the owner. Anyone can call it; the money only goes to
    ///         the owner.
    function closeExpired(uint256 mandateId) external nonReentrant {
        Mandate storage m = _mandates[mandateId];
        if (m.owner == address(0) || m.revoked) revert MandateClosed();
        if (block.timestamp <= m.expiresAt) revert BadTerms();
        m.revoked = true;
        _refund(mandateId, m, false);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Provider receipt key
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Publish the provider's post-quantum receipt-signing public key (ML-DSA-65, 1,952 bytes). Only its
    ///         hash is stored; the full key is in the event log for anyone to fetch and verify receipts with.
    function setReceiptKey(bytes calldata publicKey) external {
        if (publicKey.length == 0) revert ZeroAmount();
        bytes32 h = keccak256(publicKey);
        receiptKeyHash[msg.sender] = h;
        emit ReceiptKeySet(msg.sender, h, publicKey);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function mandateOf(uint256 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }

    /// @notice What the mandate can still be charged right now (0 if closed or expired).
    function spendable(uint256 mandateId) external view returns (uint256) {
        Mandate storage m = _mandates[mandateId];
        if (m.owner == address(0) || m.revoked || block.timestamp > m.expiresAt) return 0;
        uint256 capLeft = m.cap - m.spent;
        return capLeft < m.balance ? capLeft : m.balance;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------

    function _open(
        address owner,
        address agent,
        address provider,
        uint256 amount,
        uint256 cap,
        uint256 perRequestMax,
        uint64 expiresAt
    ) private returns (uint256 mandateId) {
        if (owner == address(0) || agent == address(0) || provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (perRequestMax == 0 || perRequestMax > cap || expiresAt <= block.timestamp) revert BadTerms();
        mandateId = nextMandateId++;
        _mandates[mandateId] = Mandate({
            owner: owner,
            agent: agent,
            provider: provider,
            expiresAt: expiresAt,
            revoked: false,
            balance: _u128(amount),
            spent: 0,
            cap: _u128(cap),
            perRequestMax: _u128(perRequestMax),
            requests: 0
        });
        emit MandateOpened(mandateId, owner, provider, agent, amount, cap, perRequestMax, expiresAt);
    }

    function _check(
        uint256 mandateId,
        bytes32 requestId,
        uint256 maxPrice,
        uint64 deadline,
        uint256 charge,
        address caller,
        bytes calldata agentSig
    ) private view returns (Status) {
        Mandate storage m = _mandates[mandateId];
        if (m.owner == address(0)) return Status.UnknownMandate;
        if (caller != m.provider) return Status.NotProvider;
        if (m.revoked) return Status.Revoked;
        if (block.timestamp > m.expiresAt) return Status.Expired;
        if (block.timestamp > deadline) return Status.PastDeadline;
        if (settled[mandateId][requestId]) return Status.AlreadySettled;
        if (charge > maxPrice) return Status.OverMaxPrice;
        if (charge > m.perRequestMax) return Status.OverPerRequestMax;
        if (uint256(m.spent) + charge > m.cap) return Status.OverCap;
        if (charge > m.balance) return Status.OverBalance;
        if (!SignatureChecker.isValidSignatureNow(m.agent, usageDigest(mandateId, requestId, maxPrice, deadline), agentSig))
        {
            return Status.BadSignature;
        }
        return Status.Ok;
    }

    function _settle(
        uint256 mandateId,
        bytes32 requestId,
        uint256 maxPrice,
        uint64 deadline,
        uint256 charge,
        bytes32 receiptHash,
        bytes calldata agentSig
    ) private returns (Status st) {
        st = _check(mandateId, requestId, maxPrice, deadline, charge, msg.sender, agentSig);
        if (st != Status.Ok) return st;
        Mandate storage m = _mandates[mandateId];
        settled[mandateId][requestId] = true;
        m.balance -= uint128(charge);
        m.spent += uint128(charge);
        m.requests += 1;
        emit Settled(mandateId, requestId, maxPrice, charge, receiptHash);
        if (charge > 0) token.safeTransfer(m.provider, charge);
    }

    function _refund(uint256 mandateId, Mandate storage m, bool revoked) private {
        uint256 refund = m.balance;
        m.balance = 0;
        emit Closed(mandateId, refund, revoked);
        if (refund > 0) token.safeTransfer(m.owner, refund);
    }

    function _live(uint256 mandateId) private view returns (Mandate storage m) {
        m = _mandates[mandateId];
        if (m.owner == address(0) || m.revoked) revert MandateClosed();
    }

    function _ownedLive(uint256 mandateId) private view returns (Mandate storage m) {
        m = _live(mandateId);
        if (msg.sender != m.owner) revert NotOwner();
    }

    function _u128(uint256 x) private pure returns (uint128) {
        if (x > type(uint128).max) revert BadTerms();
        return uint128(x);
    }
}
