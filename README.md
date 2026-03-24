# Better Refund Contract v2 — Gold Standard Edition

A production-hardened, fully-tested ERC-20 refund contract for EVM chains.

> ⚠️ **NOT AUDITED. PROVIDED AS IS. USE AT YOUR OWN RISK.**

---

## What's New in v2

| Feature | v1 | v2 |
|---|:---:|:---:|
| ERC-20 refunds | ✅ | ✅ |
| Bulk allocation via `setRefunds` | ✅ | ✅ |
| End time can only increase | ✅ | ✅ |
| Admin clawback requires 50% quorum | ✅ | ✅ |
| Contact email on-chain | ✅ | ✅ |
| OZ `ReentrancyGuard` | ❌ | ✅ |
| OZ `SafeERC20` (safe transfers) | ❌ | ✅ |
| OZ `Pausable` emergency stop | ❌ | ✅ |
| Partial claims (`withdrawRefund(amount)`) | ❌ | ✅ |
| `withdrawFullRefund()` convenience helper | ❌ | ✅ |
| Two-step admin transfer | ❌ | ✅ |
| 48-hour clawback timelock after end | ❌ | ✅ |
| `confirmSolvency()` — must fund before claims | ❌ | ✅ |
| On-chain dispute system | ❌ | ✅ |
| 7-day dispute auto-resolution | ❌ | ✅ |
| `isClawbackEligible()` public view | ❌ | ✅ |
| `totalOutstandingObligations()` view | ❌ | ✅ |
| Full NatSpec documentation | ❌ | ✅ |
| Complete test suite (13 categories, 50+ tests) | ❌ | ✅ |

---

## How It Works

### Lifecycle

```
deploy() → setRefunds() → confirmSolvency() → [claims open] → executeRefundContractClosure()
```

1. **Deploy** with token address, end timestamp, and contact email.
2. **`setRefunds`** — register claimants and their total allocations.
3. **`confirmSolvency`** — verifies the contract holds enough tokens. Anyone can call this. Claims are blocked until it succeeds.
4. **Claims period** — claimants call `withdrawRefund(amount)` or `withdrawFullRefund()` anytime before `endRefundTimestamp`.
5. **Closure** — after `endRefundTimestamp + 48h`, admin calls `executeRefundContractClosure()` if ≥ 50% of claimants have claimed.

---

### Rug-pull prevention

- `endRefundTimestamp` can only be **extended**, never shortened.
- Admin must wait **48 hours** after the window closes before clawing back.
- Admin can only claw back if **≥ 50%** of claimants have claimed at least once.
- `isClawbackEligible()` lets anyone verify on-chain whether closure is possible.

### Solvency guarantee

`confirmSolvency()` must be called (and pass) before any claims are accepted. It checks that `token.balanceOf(contract) >= sum of all unclaimed allocations`. This means claimants can verify on-chain that the money is actually there before the window opens.

### Dispute system

Claimants can file on-chain disputes with `fileDispute(amount, reason)`. The admin has 7 days to resolve via `resolveDispute(id, grantToClaimant)`. If the admin is unresponsive, anyone can call `autoResolveDispute(id)` after 7 days and the tokens are sent to the claimant automatically.

### Emergency pause

The admin can call `pause()` to freeze all claims if a bug is discovered. `unpause()` resumes normal operation.

---

## Running the Code

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run all tests
npx hardhat test

# Run tests with gas report
REPORT_GAS=true npx hardhat test

# Start a local node
npx hardhat node

# Deploy
npx hardhat ignition deploy ./ignition/modules/BetterRefund.ts
```

---

## Interface Reference

```solidity
// ── Admin ──────────────────────────────────────────────────────────────────
constructor(address token, uint256 endRefundTimestamp, string adminEmail)
function proposeAdmin(address proposed) external
function acceptAdmin() external
function setComplainEmail(string email) external
function setEndRefundTime(uint256 newTimestamp) external
function setRefunds(address[] users, uint256[] amounts) external
function confirmSolvency() external
function executeRefundContractClosure() external
function pause() external
function unpause() external
function resolveDispute(uint256 disputeId, bool grantToClaimant) external

// ── Claimant ───────────────────────────────────────────────────────────────
function withdrawRefund(uint256 amount) external
function withdrawFullRefund() external
function fileDispute(uint256 amount, string reason) external returns (uint256 id)
function autoResolveDispute(uint256 disputeId) external

// ── Views ──────────────────────────────────────────────────────────────────
function remainingRefund(address user) external view returns (uint256)
function totalClaimants() external view returns (uint256)
function isClawbackEligible() external view returns (bool)
function totalOutstandingObligations() external view returns (uint256)
```
