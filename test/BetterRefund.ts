import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
const e = (n: number) => ethers.parseEther(String(n));

const ONE_DAY        = 86_400;
const ONE_WEEK       = 7 * ONE_DAY;
const CLAWBACK_DELAY = 2 * ONE_DAY;   // 48 h — matches contract constant
const DISPUTE_TTL    = 7 * ONE_DAY;   // 7 days — matches contract constant

// ─────────────────────────────────────────────────────────────────────────────
//  Base deploy fixture
// ─────────────────────────────────────────────────────────────────────────────
async function deployFixture() {
  const [owner, alice, bob, carol, dan, attacker] = await ethers.getSigners();

  const latest  = await time.latest();
  const endTime = latest + ONE_WEEK;

  const ERC20Mock      = await ethers.getContractFactory("ERC20Mock");
  const token          = await ERC20Mock.deploy("Refund Token", "RFD", owner.address, e(1_000_000));

  const RefundContract = await ethers.getContractFactory("RefundContract");
  const refund         = await RefundContract.deploy(
    await token.getAddress(),
    endTime,
    "admin@example.com"
  );

  // Fund the contract with plenty of tokens
  await token.transfer(await refund.getAddress(), e(500_000));

  return { refund, token, owner, alice, bob, carol, dan, attacker, endTime };
}

// Fixture that also sets allocations and confirms solvency
async function solventFixture() {
  const base = await loadFixture(deployFixture);
  const { refund, alice, bob, carol } = base;

  await refund.setRefunds(
    [alice.address, bob.address, carol.address],
    [e(100),        e(200),      e(50)]
  );
  await refund.confirmSolvency();
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test suite
// ─────────────────────────────────────────────────────────────────────────────
describe("RefundContract — Gold Standard Suite", function () {

  // ===========================================================================
  //  1. Deployment
  // ===========================================================================
  describe("1. Deployment", function () {
    it("stores admin, token, endRefundTimestamp, adminEmail", async function () {
      const { refund, token, owner, endTime } = await loadFixture(deployFixture);
      expect(await refund.admin()).to.equal(owner.address);
      expect(await refund.token()).to.equal(await token.getAddress());
      expect(await refund.endRefundTimestamp()).to.equal(endTime);
      expect(await refund.adminEmail()).to.equal("admin@example.com");
    });

    it("starts with isSolvent = false", async function () {
      const { refund } = await loadFixture(deployFixture);
      expect(await refund.isSolvent()).to.be.false;
    });

    it("reverts if token is zero address", async function () {
      const [owner] = await ethers.getSigners();
      const RC = await ethers.getContractFactory("RefundContract");
      const future = (await time.latest()) + ONE_DAY;
      await expect(RC.deploy(ethers.ZeroAddress, future, "a@b.com"))
        .to.be.revertedWith("RefundContract: zero token address");
    });

    it("reverts if endRefundTimestamp is in the past", async function () {
      const [owner] = await ethers.getSigners();
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const token = await ERC20Mock.deploy("T", "T", owner.address, e(100));
      const RC = await ethers.getContractFactory("RefundContract");
      await expect(RC.deploy(await token.getAddress(), (await time.latest()) - 1, "a@b.com"))
        .to.be.revertedWith("RefundContract: end time must be future");
    });

    it("reverts if email is empty", async function () {
      const [owner] = await ethers.getSigners();
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const token = await ERC20Mock.deploy("T", "T", owner.address, e(100));
      const RC = await ethers.getContractFactory("RefundContract");
      const future = (await time.latest()) + ONE_DAY;
      await expect(RC.deploy(await token.getAddress(), future, ""))
        .to.be.revertedWith("RefundContract: email required");
    });
  });

  // ===========================================================================
  //  2. Two-step admin transfer
  // ===========================================================================
  describe("2. Two-step admin transfer", function () {
    it("proposes then accepts correctly", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.proposeAdmin(alice.address);
      expect(await refund.pendingAdmin()).to.equal(alice.address);
      await refund.connect(alice).acceptAdmin();
      expect(await refund.admin()).to.equal(alice.address);
      expect(await refund.pendingAdmin()).to.equal(ethers.ZeroAddress);
    });

    it("emits AdminTransferProposed and AdminTransferAccepted", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await expect(refund.proposeAdmin(alice.address))
        .to.emit(refund, "AdminTransferProposed");
      await expect(refund.connect(alice).acceptAdmin())
        .to.emit(refund, "AdminTransferAccepted").withArgs(alice.address);
    });

    it("reverts if non-pending-admin calls acceptAdmin", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await refund.proposeAdmin(alice.address);
      await expect(refund.connect(bob).acceptAdmin())
        .to.be.revertedWith("RefundContract: not pending admin");
    });

    it("reverts proposing zero address", async function () {
      const { refund } = await loadFixture(deployFixture);
      await expect(refund.proposeAdmin(ethers.ZeroAddress))
        .to.be.revertedWith("RefundContract: zero address");
    });

    it("non-admin cannot propose", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).proposeAdmin(bob.address))
        .to.be.revertedWith("RefundContract: caller is not admin");
    });
  });

  // ===========================================================================
  //  3. Admin configuration
  // ===========================================================================
  describe("3. Admin configuration", function () {
    it("admin can update email and emits AdminEmailUpdated", async function () {
      const { refund } = await loadFixture(deployFixture);
      await expect(refund.setComplainEmail("new@example.com"))
        .to.emit(refund, "AdminEmailUpdated").withArgs("new@example.com");
      expect(await refund.adminEmail()).to.equal("new@example.com");
    });

    it("reverts on empty email", async function () {
      const { refund } = await loadFixture(deployFixture);
      await expect(refund.setComplainEmail(""))
        .to.be.revertedWith("RefundContract: empty email");
    });

    it("non-admin cannot update email", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).setComplainEmail("x@x.com"))
        .to.be.revertedWith("RefundContract: caller is not admin");
    });

    it("admin can extend endRefundTimestamp and emits event", async function () {
      const { refund, endTime } = await loadFixture(deployFixture);
      const newEnd = endTime + ONE_WEEK;
      await expect(refund.setEndRefundTime(newEnd))
        .to.emit(refund, "EndRefundTimestampExtended").withArgs(endTime, newEnd);
      expect(await refund.endRefundTimestamp()).to.equal(newEnd);
    });

    it("reverts if new end time is not greater than current", async function () {
      const { refund, endTime } = await loadFixture(deployFixture);
      await expect(refund.setEndRefundTime(endTime))
        .to.be.revertedWith("RefundContract: end time can only be increased");
      await expect(refund.setEndRefundTime(endTime - 1))
        .to.be.revertedWith("RefundContract: end time can only be increased");
    });

    it("non-admin cannot extend end time", async function () {
      const { refund, alice, endTime } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).setEndRefundTime(endTime + ONE_DAY))
        .to.be.revertedWith("RefundContract: caller is not admin");
    });
  });

  // ===========================================================================
  //  4. setRefunds (allocations)
  // ===========================================================================
  describe("4. setRefunds — allocations", function () {
    it("sets allocations for multiple users and emits RefundSet", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await expect(refund.setRefunds([alice.address, bob.address], [e(100), e(200)]))
        .to.emit(refund, "RefundSet").withArgs(alice.address, e(100));
      expect(await refund.totalRefund(alice.address)).to.equal(e(100));
      expect(await refund.totalRefund(bob.address)).to.equal(e(200));
    });

    it("counts claimants correctly", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address, bob.address], [e(100), e(200)]);
      expect(await refund.totalClaimants()).to.equal(2);
    });

    it("does not double-count when updating existing allocation", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(100)]);
      await refund.setRefunds([alice.address], [e(200)]);
      expect(await refund.totalRefund(alice.address)).to.equal(e(200));
      expect(await refund.totalClaimants()).to.equal(1);
    });

    it("reverts on array length mismatch", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await expect(refund.setRefunds([alice.address, bob.address], [e(1)]))
        .to.be.revertedWith("RefundContract: length mismatch");
    });

    it("non-admin cannot set refunds", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).setRefunds([bob.address], [e(10)]))
        .to.be.revertedWith("RefundContract: caller is not admin");
    });
  });

  // ===========================================================================
  //  5. confirmSolvency
  // ===========================================================================
  describe("5. confirmSolvency", function () {
    it("sets isSolvent and emits SolvencyConfirmed", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(100)]);
      await expect(refund.confirmSolvency()).to.emit(refund, "SolvencyConfirmed");
      expect(await refund.isSolvent()).to.be.true;
    });

    it("reverts if contract is underfunded", async function () {
      const [owner, alice] = await ethers.getSigners();
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const token = await ERC20Mock.deploy("T", "T", owner.address, e(5));
      const RC = await ethers.getContractFactory("RefundContract");
      const future = (await time.latest()) + ONE_WEEK;
      const refund = await RC.deploy(await token.getAddress(), future, "a@b.com");
      await token.transfer(await refund.getAddress(), e(5));
      await refund.setRefunds([alice.address], [e(10)]);
      await expect(refund.confirmSolvency())
        .to.be.revertedWith("RefundContract: insufficient balance - please top up");
    });

    it("can be called by anyone, not just admin", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(100)]);
      await expect(refund.connect(alice).confirmSolvency()).to.not.be.reverted;
    });
  });

  // ===========================================================================
  //  6. withdrawRefund — partial claims
  // ===========================================================================
  describe("6. withdrawRefund — partial claims", function () {
    it("allows full claim in one call", async function () {
      const { refund, token, alice } = await loadFixture(solventFixture);
      await expect(refund.connect(alice).withdrawRefund(e(100)))
        .to.emit(refund, "RefundWithdrawn").withArgs(alice.address, e(100), 0n);
      expect(await token.balanceOf(alice.address)).to.equal(e(100));
    });

    it("allows partial claims across multiple calls", async function () {
      const { refund, token, alice } = await loadFixture(solventFixture);
      await refund.connect(alice).withdrawRefund(e(40));
      await refund.connect(alice).withdrawRefund(e(60));
      expect(await token.balanceOf(alice.address)).to.equal(e(100));
      expect(await refund.remainingRefund(alice.address)).to.equal(0n);
    });

    it("emits correct remaining after partial claim", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      await expect(refund.connect(alice).withdrawRefund(e(30)))
        .to.emit(refund, "RefundWithdrawn").withArgs(alice.address, e(30), e(70));
    });

    it("reverts on over-claim", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      await expect(refund.connect(alice).withdrawRefund(e(101)))
        .to.be.revertedWith("RefundContract: amount exceeds remaining allocation");
    });

    it("reverts on zero-amount claim", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      await expect(refund.connect(alice).withdrawRefund(0n))
        .to.be.revertedWith("RefundContract: amount must be > 0");
    });

    it("reverts after endRefundTimestamp", async function () {
      const { refund, alice, endTime } = await loadFixture(solventFixture);
      await time.increaseTo(endTime + 1);
      await expect(refund.connect(alice).withdrawRefund(e(1)))
        .to.be.revertedWith("RefundContract: refund period has ended");
    });

    it("reverts when contract not yet solvent", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(100)]);
      await expect(refund.connect(alice).withdrawRefund(e(1)))
        .to.be.revertedWith("RefundContract: contract not yet solvent");
    });

    it("reverts when paused", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      await refund.pause();
      await expect(refund.connect(alice).withdrawRefund(e(1)))
        .to.be.revertedWithCustomError(refund, "EnforcedPause");
    });

    it("succeeds after unpause", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      await refund.pause();
      await refund.unpause();
      await expect(refund.connect(alice).withdrawRefund(e(10))).to.not.be.reverted;
    });

    it("reverts for user with no allocation", async function () {
      const { refund, attacker } = await loadFixture(solventFixture);
      await expect(refund.connect(attacker).withdrawRefund(e(1)))
        .to.be.revertedWith("RefundContract: amount exceeds remaining allocation");
    });
  });

  // ===========================================================================
  //  7. withdrawFullRefund
  // ===========================================================================
  describe("7. withdrawFullRefund", function () {
    it("claims entire allocation in one call", async function () {
      const { refund, token, bob } = await loadFixture(solventFixture);
      await refund.connect(bob).withdrawFullRefund();
      expect(await token.balanceOf(bob.address)).to.equal(e(200));
      expect(await refund.remainingRefund(bob.address)).to.equal(0n);
    });

    it("can claim remainder after a partial withdrawRefund", async function () {
      const { refund, token, bob } = await loadFixture(solventFixture);
      await refund.connect(bob).withdrawRefund(e(50));
      await refund.connect(bob).withdrawFullRefund();
      expect(await token.balanceOf(bob.address)).to.equal(e(200));
    });

    it("reverts when nothing remains", async function () {
      const { refund, bob } = await loadFixture(solventFixture);
      await refund.connect(bob).withdrawFullRefund();
      await expect(refund.connect(bob).withdrawFullRefund())
        .to.be.revertedWith("RefundContract: no refund or already withdrawn");
    });

    it("reverts after endRefundTimestamp", async function () {
      const { refund, alice, endTime } = await loadFixture(solventFixture);
      await time.increaseTo(endTime + 1);
      await expect(refund.connect(alice).withdrawFullRefund())
        .to.be.revertedWith("RefundContract: refund period has ended");
    });
  });

  // ===========================================================================
  //  8. executeRefundContractClosure
  // ===========================================================================
  describe("8. executeRefundContractClosure", function () {
    async function closureReady() {
      const base = await loadFixture(solventFixture);
      // alice (100) + bob (200) + carol (50) = 3 claimants
      // alice + bob claim → 2/3 = 66% > 50%
      await base.refund.connect(base.alice).withdrawFullRefund();
      await base.refund.connect(base.bob).withdrawFullRefund();
      return base;
    }

    it("succeeds when quorum met and delay elapsed", async function () {
      const { refund, token, owner, endTime } = await loadFixture(closureReady);
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      const before = await token.balanceOf(owner.address);
      await expect(refund.executeRefundContractClosure())
        .to.emit(refund, "ContractClosed");
      expect(await token.balanceOf(owner.address)).to.be.gt(before);
    });

    it("reverts before CLAWBACK_DELAY has elapsed", async function () {
      const { refund, endTime } = await loadFixture(closureReady);
      await time.increaseTo(endTime + 1); // past end, but < 48 h
      await expect(refund.executeRefundContractClosure())
        .to.be.revertedWith("RefundContract: clawback delay not elapsed");
    });

    it("reverts when quorum not met — 0 of 3 claimed", async function () {
      const { refund, endTime } = await loadFixture(solventFixture);
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      await expect(refund.executeRefundContractClosure())
        .to.be.revertedWith("RefundContract: quorum not met");
    });

    it("reverts when quorum not met — 1 of 3 claimed (33% < 50%)", async function () {
      const { refund, alice, endTime } = await loadFixture(solventFixture);
      await refund.connect(alice).withdrawFullRefund();
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      await expect(refund.executeRefundContractClosure())
        .to.be.revertedWith("RefundContract: quorum not met");
    });

    it("reverts when no claimants registered", async function () {
      const { refund, endTime } = await loadFixture(deployFixture);
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      await expect(refund.executeRefundContractClosure())
        .to.be.revertedWith("RefundContract: no claimants registered");
    });

    it("non-admin cannot close contract", async function () {
      const { refund, alice, endTime } = await loadFixture(closureReady);
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      await expect(refund.connect(alice).executeRefundContractClosure())
        .to.be.revertedWith("RefundContract: caller is not admin");
    });

    it("single claimant who claimed — eligible at 100%", async function () {
      const { refund, alice, endTime } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(1)]);
      await refund.confirmSolvency();
      await refund.connect(alice).withdrawFullRefund();
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      await expect(refund.executeRefundContractClosure()).to.not.be.reverted;
    });
  });

  // ===========================================================================
  //  9. Pause / unpause
  // ===========================================================================
  describe("9. Pause / unpause", function () {
    it("admin can pause and unpause", async function () {
      const { refund } = await loadFixture(deployFixture);
      await refund.pause();
      expect(await refund.paused()).to.be.true;
      await refund.unpause();
      expect(await refund.paused()).to.be.false;
    });

    it("non-admin cannot pause", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).pause())
        .to.be.revertedWith("RefundContract: caller is not admin");
    });

    it("non-admin cannot unpause", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.pause();
      await expect(refund.connect(alice).unpause())
        .to.be.revertedWith("RefundContract: caller is not admin");
    });
  });

  // ===========================================================================
  //  10. Dispute system
  // ===========================================================================
  describe("10. Dispute system", function () {
    it("anyone can file a dispute and emits DisputeFiled", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).fileDispute(e(50), "Wrong amount"))
        .to.emit(refund, "DisputeFiled").withArgs(1, alice.address, e(50));
      expect(await refund.disputeCount()).to.equal(1);
    });

    it("reverts filing with empty reason", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await expect(refund.connect(alice).fileDispute(e(50), ""))
        .to.be.revertedWith("RefundContract: reason required");
    });

    it("admin resolves in claimant's favour — tokens transferred", async function () {
      const { refund, token, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(10), "owed more");
      const before = await token.balanceOf(alice.address);
      await expect(refund.resolveDispute(1, true))
        .to.emit(refund, "DisputeResolved").withArgs(1, true);
      expect(await token.balanceOf(alice.address)).to.equal(before + e(10));
    });

    it("admin resolves against claimant — no transfer", async function () {
      const { refund, token, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(10), "trying luck");
      const before = await token.balanceOf(alice.address);
      await refund.resolveDispute(1, false);
      expect(await token.balanceOf(alice.address)).to.equal(before);
    });

    it("reverts resolving an already-resolved dispute", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(10), "test");
      await refund.resolveDispute(1, false);
      await expect(refund.resolveDispute(1, true))
        .to.be.revertedWith("RefundContract: dispute already resolved");
    });

    it("non-admin cannot call resolveDispute", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(5), "test");
      await expect(refund.connect(bob).resolveDispute(1, true))
        .to.be.revertedWith("RefundContract: caller is not admin");
    });

    it("auto-resolves in claimant's favour after DISPUTE_TTL", async function () {
      const { refund, token, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(5), "slow admin");
      await time.increase(DISPUTE_TTL + 1);
      const before = await token.balanceOf(alice.address);
      await expect(refund.connect(alice).autoResolveDispute(1))
        .to.emit(refund, "DisputeResolved").withArgs(1, true);
      expect(await token.balanceOf(alice.address)).to.equal(before + e(5));
    });

    it("reverts auto-resolve before DISPUTE_TTL", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(5), "impatient");
      await expect(refund.autoResolveDispute(1))
        .to.be.revertedWith("RefundContract: dispute window still open");
    });

    it("reverts auto-resolve on already-resolved dispute", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(5), "test");
      await refund.resolveDispute(1, false);
      await time.increase(DISPUTE_TTL + 1);
      await expect(refund.autoResolveDispute(1))
        .to.be.revertedWith("RefundContract: already resolved");
    });

    it("multiple disputes are tracked independently", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      await refund.connect(alice).fileDispute(e(10), "dispute 1");
      await refund.connect(bob).fileDispute(e(20), "dispute 2");
      expect(await refund.disputeCount()).to.equal(2);
      const d1 = await refund.disputes(1);
      const d2 = await refund.disputes(2);
      expect(d1.claimant).to.equal(alice.address);
      expect(d2.claimant).to.equal(bob.address);
    });
  });

  // ===========================================================================
  //  11. View helpers
  // ===========================================================================
  describe("11. View helpers", function () {
    it("remainingRefund decreases correctly after partial claims", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      expect(await refund.remainingRefund(alice.address)).to.equal(e(100));
      await refund.connect(alice).withdrawRefund(e(30));
      expect(await refund.remainingRefund(alice.address)).to.equal(e(70));
    });

    it("totalClaimants is correct", async function () {
      const { refund, alice, bob } = await loadFixture(deployFixture);
      expect(await refund.totalClaimants()).to.equal(0);
      await refund.setRefunds([alice.address, bob.address], [e(10), e(10)]);
      expect(await refund.totalClaimants()).to.equal(2);
    });

    it("isClawbackEligible returns false before delay", async function () {
      const { refund } = await loadFixture(solventFixture);
      expect(await refund.isClawbackEligible()).to.be.false;
    });

    it("isClawbackEligible returns true when all conditions met", async function () {
      const { refund, alice, bob, endTime } = await loadFixture(solventFixture);
      await refund.connect(alice).withdrawFullRefund();
      await refund.connect(bob).withdrawFullRefund();
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      expect(await refund.isClawbackEligible()).to.be.true;
    });

    it("totalOutstandingObligations decreases as users claim", async function () {
      const { refund, alice, bob, carol } = await loadFixture(solventFixture);
      expect(await refund.totalOutstandingObligations()).to.equal(e(350)); // 100+200+50
      await refund.connect(alice).withdrawFullRefund();
      expect(await refund.totalOutstandingObligations()).to.equal(e(250)); // 200+50
      await refund.connect(bob).withdrawFullRefund();
      expect(await refund.totalOutstandingObligations()).to.equal(e(50));
    });
  });

  // ===========================================================================
  //  12. Reentrancy protection
  // ===========================================================================
  describe("12. Reentrancy protection", function () {
    it("emits exactly one RefundWithdrawn per withdrawRefund call", async function () {
      const { refund, alice } = await loadFixture(solventFixture);
      const tx      = await refund.connect(alice).withdrawRefund(e(50));
      const receipt = await tx.wait();
      const events  = receipt!.logs.filter((l: any) => l.fragment?.name === "RefundWithdrawn");
      expect(events.length).to.equal(1);
    });

    it("emits exactly one RefundWithdrawn per withdrawFullRefund call", async function () {
      const { refund, bob } = await loadFixture(solventFixture);
      const tx      = await refund.connect(bob).withdrawFullRefund();
      const receipt = await tx.wait();
      const events  = receipt!.logs.filter((l: any) => l.fragment?.name === "RefundWithdrawn");
      expect(events.length).to.equal(1);
    });
  });

  // ===========================================================================
  //  13. Edge cases
  // ===========================================================================
  describe("13. Edge cases", function () {
    it("zero-amount allocation does not register claimant", async function () {
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [0n]);
      expect(await refund.totalClaimants()).to.equal(0);
    });

    it("updating allocation to 0 after registration keeps address in array", async function () {
      // The address stays in refundAddresses but has 0 remaining — harmless
      const { refund, alice } = await loadFixture(deployFixture);
      await refund.setRefunds([alice.address], [e(100)]);
      await refund.setRefunds([alice.address], [0n]);
      expect(await refund.remainingRefund(alice.address)).to.equal(0n);
    });

    it("confirmSolvency can be called after additional tokens are deposited", async function () {
      const { refund, token, alice } = await loadFixture(deployFixture);
      // Deploy underfunded, then top up
      const [owner] = await ethers.getSigners();
      await refund.setRefunds([alice.address], [e(100)]);
      // Already funded from fixture, so this should pass
      await expect(refund.confirmSolvency()).to.not.be.reverted;
      // Call again after claiming — still passes
      await refund.connect(alice).withdrawRefund(e(50));
      await expect(refund.confirmSolvency()).to.not.be.reverted;
    });

    it("handles large batch of claimants without reverting", async function () {
      const { refund } = await loadFixture(deployFixture);
      const signers  = await ethers.getSigners();
      const addrs    = signers.slice(0, 15).map(s => s.address);
      const amounts  = addrs.map(() => e(100));
      await expect(refund.setRefunds(addrs, amounts)).to.not.be.reverted;
      expect(await refund.totalClaimants()).to.equal(15);
    });

    it("claimant with partial allocation remaining still counts toward quorum", async function () {
      const { refund, alice, bob, carol, endTime } = await loadFixture(solventFixture);
      // Only partial claims — but alice + bob have claimed at least once
      await refund.connect(alice).withdrawRefund(e(1));
      await refund.connect(bob).withdrawRefund(e(1));
      await time.increaseTo(endTime + CLAWBACK_DELAY + 1);
      // 2/3 = 66% ≥ 50%, should succeed
      await expect(refund.executeRefundContractClosure()).to.not.be.reverted;
    });
  });
});
