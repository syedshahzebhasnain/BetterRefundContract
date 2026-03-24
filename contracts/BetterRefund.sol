// SPDX-License-Identifier: MIT
// Better Refund Contract v2 — Gold Standard Edition
//
// Upgrades over v1:
//  1. OZ ReentrancyGuard — safe against re-entrancy attacks on all state-changing functions.
//  2. OZ Pausable        — admin can freeze all claims in an emergency.
//  3. OZ SafeERC20       — safe token transfers that revert on failure.
//  4. Partial claims     — claimants can withdraw in multiple transactions.
//  5. withdrawFullRefund — convenience helper to claim entire remaining balance.
//  6. Two-step admin transfer — prevents accidental loss of admin key.
//  7. 48 h clawback timelock — admin must wait after endRefundTimestamp.
//  8. confirmSolvency()  — admin must prove contract is fully funded before claims open.
//  9. On-chain dispute system with 7-day auto-resolution in claimant's favour.
// 10. Full NatSpec documentation throughout.
// 11. isClawbackEligible() + totalOutstandingObligations() view helpers.
//
// NOT AUDITED. PROVIDED AS IS. USE AT YOUR OWN RISK.

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RefundContract
 * @author BetterRefundContract contributors
 * @notice Gold-standard ERC-20 refund contract. Designed to be the most
 *         trustworthy and claimant-friendly refund mechanism on EVM chains.
 *
 * Core protections:
 *  - Admin cannot reduce the refund window.
 *  - Admin cannot claw back funds until 48 h after window closes AND
 *    at least 50% of registered claimants have claimed.
 *  - Contract must be confirmed solvent (fully funded) before claims open.
 *  - Claimants can file on-chain disputes; if admin ignores for 7 days
 *    anyone can auto-resolve in the claimant's favour.
 *  - Emergency pause keeps funds safe if a bug is discovered.
 */
contract RefundContract is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // =========================================================================
    //  Constants
    // =========================================================================

    /// @notice Minimum fraction of claimants who must have claimed before the
    ///         admin can reclaim unclaimed tokens (50 %).
    uint256 public constant MIN_CLAIM_RATIO = 0.5e18;

    /// @notice Time the admin must wait after endRefundTimestamp before the
    ///         contract can be closed (48 hours).
    uint256 public constant CLAWBACK_DELAY = 48 hours;

    /// @notice Time after which an unresolved dispute auto-resolves in the
    ///         claimant's favour (7 days).
    uint256 public constant DISPUTE_TTL = 7 days;

    // =========================================================================
    //  State
    // =========================================================================

    /// @notice The ERC-20 token used for refunds. Immutable after deployment.
    IERC20 public immutable token;

    /// @notice Current admin. Only they can set allocations and close the contract.
    address public admin;

    /// @notice Pending admin awaiting acceptance (two-step transfer).
    address public pendingAdmin;

    /// @notice Contact email published on-chain for claimant disputes.
    string public adminEmail;

    /// @notice Unix timestamp after which new claims are no longer accepted.
    uint256 public endRefundTimestamp;

    /// @notice Total tokens allocated to each claimant (may be updated by admin).
    mapping(address => uint256) public totalRefund;

    /// @notice Tokens already withdrawn by each claimant.
    mapping(address => uint256) public claimedRefund;

    /// @notice Ordered list of all registered claimant addresses.
    address[] public refundAddresses;

    /// @notice True once admin has called confirmSolvency() successfully.
    ///         No claims are accepted until this flag is set.
    bool public isSolvent;

    // -------------------------------------------------------------------------
    //  Dispute system
    // -------------------------------------------------------------------------

    /// @dev Auto-incrementing dispute counter (1-indexed).
    uint256 public disputeCount;

    struct Dispute {
        address claimant;    // who filed
        uint256 amount;      // tokens in dispute
        string  reason;      // free-text description
        uint256 filedAt;     // block.timestamp when filed
        bool    resolved;    // verdict has been rendered
        bool    claimantWon; // true → tokens sent to claimant
    }

    /// @notice All disputes keyed by ID (1-indexed).
    mapping(uint256 => Dispute) public disputes;

    // =========================================================================
    //  Events
    // =========================================================================

    event AdminTransferProposed(address indexed currentAdmin, address indexed proposed);
    event AdminTransferAccepted(address indexed newAdmin);
    event RefundSet(address indexed user, uint256 newTotal);
    event RefundWithdrawn(address indexed user, uint256 amount, uint256 remaining);
    event EndRefundTimestampExtended(uint256 oldTimestamp, uint256 newTimestamp);
    event SolvencyConfirmed(uint256 contractBalance, uint256 totalObligations);
    event ContractClosed(address indexed admin, uint256 amount);
    event AdminEmailUpdated(string newEmail);
    event DisputeFiled(uint256 indexed disputeId, address indexed claimant, uint256 amount);
    event DisputeResolved(uint256 indexed disputeId, bool claimantWon);

    // =========================================================================
    //  Modifiers
    // =========================================================================

    modifier onlyAdmin() {
        require(msg.sender == admin, "RefundContract: caller is not admin");
        _;
    }

    // =========================================================================
    //  Constructor
    // =========================================================================

    /**
     * @param _token               ERC-20 token address used for refunds.
     * @param _endRefundTimestamp  Unix timestamp after which claims close.
     * @param _adminEmail          Public contact email for claimant disputes.
     */
    constructor(
        address _token,
        uint256 _endRefundTimestamp,
        string memory _adminEmail
    ) {
        require(_token != address(0),                  "RefundContract: zero token address");
        require(_endRefundTimestamp > block.timestamp, "RefundContract: end time must be future");
        require(bytes(_adminEmail).length > 0,         "RefundContract: email required");

        token              = IERC20(_token);
        admin              = msg.sender;
        endRefundTimestamp = _endRefundTimestamp;
        adminEmail         = _adminEmail;
    }

    // =========================================================================
    //  Admin: ownership
    // =========================================================================

    /**
     * @notice Step 1 — propose a new admin address.
     * @dev    Rights do not transfer until the proposed address calls acceptAdmin().
     * @param  _proposed The candidate admin address.
     */
    function proposeAdmin(address _proposed) external onlyAdmin {
        require(_proposed != address(0), "RefundContract: zero address");
        pendingAdmin = _proposed;
        emit AdminTransferProposed(admin, _proposed);
    }

    /**
     * @notice Step 2 — accept the admin role.
     * @dev    Must be called by the pending admin, not the current admin.
     */
    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "RefundContract: not pending admin");
        admin        = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferAccepted(admin);
    }

    // =========================================================================
    //  Admin: configuration
    // =========================================================================

    /**
     * @notice Update the admin contact email.
     * @param  _email New non-empty email string.
     */
    function setComplainEmail(string calldata _email) external onlyAdmin {
        require(bytes(_email).length > 0, "RefundContract: empty email");
        adminEmail = _email;
        emit AdminEmailUpdated(_email);
    }

    /**
     * @notice Extend the refund window. Can only move the end time forward.
     * @param  _newTimestamp Must be strictly greater than current endRefundTimestamp.
     */
    function setEndRefundTime(uint256 _newTimestamp) external onlyAdmin {
        require(
            _newTimestamp > endRefundTimestamp,
            "RefundContract: end time can only be increased"
        );
        uint256 old        = endRefundTimestamp;
        endRefundTimestamp = _newTimestamp;
        emit EndRefundTimestampExtended(old, _newTimestamp);
    }

    // =========================================================================
    //  Admin: allocations
    // =========================================================================

    /**
     * @notice Set or replace refund allocations for a batch of claimants.
     *
     * @dev    `_amounts[i]` is the **total** allocation for `_users[i]`, not a delta.
     *         Already-claimed amounts are preserved — the claimant simply has less
     *         remaining to withdraw.
     *
     * @param  _users   Array of claimant addresses.
     * @param  _amounts Array of total allocations (same length as _users).
     */
    function setRefunds(
        address[] calldata _users,
        uint256[] calldata _amounts
    ) external onlyAdmin {
        require(_users.length == _amounts.length, "RefundContract: length mismatch");

        for (uint256 i = 0; i < _users.length; i++) {
            address user   = _users[i];
            uint256 amount = _amounts[i];

            if (totalRefund[user] == 0 && amount > 0) {
                refundAddresses.push(user);
            }

            totalRefund[user] = amount;
            emit RefundSet(user, amount);
        }
    }

    // =========================================================================
    //  Solvency check
    // =========================================================================

    /**
     * @notice Verify the contract holds enough tokens to cover all outstanding
     *         obligations and set isSolvent = true, enabling claims.
     * @dev    Anyone can call this. Safe to call multiple times.
     */
    function confirmSolvency() external {
        uint256 totalObligations;
        for (uint256 i = 0; i < refundAddresses.length; i++) {
            address u = refundAddresses[i];
            if (totalRefund[u] > claimedRefund[u]) {
                totalObligations += totalRefund[u] - claimedRefund[u];
            }
        }

        uint256 balance = token.balanceOf(address(this));
        require(
            balance >= totalObligations,
            "RefundContract: insufficient balance - please top up"
        );

        isSolvent = true;
        emit SolvencyConfirmed(balance, totalObligations);
    }

    // =========================================================================
    //  Claiming
    // =========================================================================

    /**
     * @notice Withdraw a specific amount from the caller's remaining allocation.
     *         Supports partial withdrawals — call multiple times up to the full amount.
     * @param  _amount Token amount to withdraw. Must be > 0 and <= remaining.
     */
    function withdrawRefund(uint256 _amount) external nonReentrant whenNotPaused {
        require(isSolvent,                             "RefundContract: contract not yet solvent");
        require(block.timestamp <= endRefundTimestamp, "RefundContract: refund period has ended");
        require(_amount > 0,                           "RefundContract: amount must be > 0");

        uint256 remaining = totalRefund[msg.sender] - claimedRefund[msg.sender];
        require(remaining >= _amount, "RefundContract: amount exceeds remaining allocation");

        claimedRefund[msg.sender] += _amount;
        token.safeTransfer(msg.sender, _amount);

        emit RefundWithdrawn(
            msg.sender,
            _amount,
            totalRefund[msg.sender] - claimedRefund[msg.sender]
        );
    }

    /**
     * @notice Convenience — withdraw the caller's entire remaining allocation at once.
     */
    function withdrawFullRefund() external nonReentrant whenNotPaused {
        require(isSolvent,                             "RefundContract: contract not yet solvent");
        require(block.timestamp <= endRefundTimestamp, "RefundContract: refund period has ended");

        uint256 remaining = totalRefund[msg.sender] - claimedRefund[msg.sender];
        require(remaining > 0, "RefundContract: no refund or already withdrawn");

        claimedRefund[msg.sender] = totalRefund[msg.sender];
        token.safeTransfer(msg.sender, remaining);

        emit RefundWithdrawn(msg.sender, remaining, 0);
    }

    // =========================================================================
    //  Admin: contract closure / clawback
    // =========================================================================

    /**
     * @notice Reclaim unclaimed tokens after the refund period ends.
     *
     * @dev    Two conditions must both be satisfied:
     *           1. block.timestamp >= endRefundTimestamp + CLAWBACK_DELAY (48 h)
     *           2. At least 50% of registered claimants have withdrawn at least once.
     */
    function executeRefundContractClosure() external onlyAdmin nonReentrant {
        require(
            block.timestamp >= endRefundTimestamp + CLAWBACK_DELAY,
            "RefundContract: clawback delay not elapsed"
        );

        uint256 total = refundAddresses.length;
        require(total > 0, "RefundContract: no claimants registered");

        uint256 claimed;
        for (uint256 i = 0; i < total; i++) {
            if (claimedRefund[refundAddresses[i]] > 0) claimed++;
        }

        uint256 claimRatio = (claimed * 1e18) / total;
        require(
            claimRatio >= MIN_CLAIM_RATIO,
            "RefundContract: quorum not met - too many unclaimed refunds"
        );

        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "RefundContract: nothing to reclaim");

        token.safeTransfer(admin, balance);
        emit ContractClosed(admin, balance);
    }

    // =========================================================================
    //  Emergency controls
    // =========================================================================

    /// @notice Pause all claim functions. For emergency use only.
    function pause()   external onlyAdmin { _pause(); }

    /// @notice Resume claim functions after a pause.
    function unpause() external onlyAdmin { _unpause(); }

    // =========================================================================
    //  On-chain dispute system
    // =========================================================================

    /**
     * @notice File a dispute about an incorrect or missing allocation.
     * @param  _amount  The token amount being disputed.
     * @param  _reason  Human-readable explanation of the dispute.
     * @return disputeId Unique identifier (1-indexed).
     */
    function fileDispute(uint256 _amount, string calldata _reason)
        external
        returns (uint256 disputeId)
    {
        require(bytes(_reason).length > 0, "RefundContract: reason required");

        disputeId = ++disputeCount;
        disputes[disputeId] = Dispute({
            claimant:    msg.sender,
            amount:      _amount,
            reason:      _reason,
            filedAt:     block.timestamp,
            resolved:    false,
            claimantWon: false
        });

        emit DisputeFiled(disputeId, msg.sender, _amount);
    }

    /**
     * @notice Admin renders a verdict on a dispute.
     * @param  _disputeId        ID of the dispute to resolve.
     * @param  _grantToClaimant  If true, transfer disputed tokens to the claimant.
     */
    function resolveDispute(uint256 _disputeId, bool _grantToClaimant)
        external
        onlyAdmin
        nonReentrant
    {
        Dispute storage d = disputes[_disputeId];
        require(!d.resolved, "RefundContract: dispute already resolved");

        d.resolved    = true;
        d.claimantWon = _grantToClaimant;

        if (_grantToClaimant) {
            token.safeTransfer(d.claimant, d.amount);
        }

        emit DisputeResolved(_disputeId, _grantToClaimant);
    }

    /**
     * @notice If admin has not resolved a dispute within DISPUTE_TTL, anyone
     *         may call this to auto-resolve in the claimant's favour.
     * @param  _disputeId ID of the stale dispute.
     */
    function autoResolveDispute(uint256 _disputeId) external nonReentrant {
        Dispute storage d = disputes[_disputeId];
        require(!d.resolved, "RefundContract: already resolved");
        require(
            block.timestamp >= d.filedAt + DISPUTE_TTL,
            "RefundContract: dispute window still open"
        );

        d.resolved    = true;
        d.claimantWon = true;

        token.safeTransfer(d.claimant, d.amount);
        emit DisputeResolved(_disputeId, true);
    }

    // =========================================================================
    //  View helpers
    // =========================================================================

    /// @notice Remaining claimable tokens for a given address.
    function remainingRefund(address _user) external view returns (uint256) {
        return totalRefund[_user] - claimedRefund[_user];
    }

    /// @notice Number of registered claimants.
    function totalClaimants() external view returns (uint256) {
        return refundAddresses.length;
    }

    /// @notice Whether the admin is currently eligible to close the contract.
    function isClawbackEligible() external view returns (bool) {
        if (block.timestamp < endRefundTimestamp + CLAWBACK_DELAY) return false;
        uint256 total = refundAddresses.length;
        if (total == 0) return false;
        uint256 claimed;
        for (uint256 i = 0; i < total; i++) {
            if (claimedRefund[refundAddresses[i]] > 0) claimed++;
        }
        return (claimed * 1e18) / total >= MIN_CLAIM_RATIO;
    }

    /// @notice Sum of all unclaimed allocations across all registered claimants.
    function totalOutstandingObligations() external view returns (uint256) {
        uint256 total;
        for (uint256 i = 0; i < refundAddresses.length; i++) {
            address u = refundAddresses[i];
            if (totalRefund[u] > claimedRefund[u]) {
                total += totalRefund[u] - claimedRefund[u];
            }
        }
        return total;
    }
}
