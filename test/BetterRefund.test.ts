import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, parseEther, parseUnits } from "ethers";
import { ERC20Mock, ERC20Mock__factory, RefundContract, RefundContract__factory } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("BetterRefundContract", function () {

  let RefundContractFactory: RefundContract__factory;
  let refundContract: RefundContract;
  let token: ERC20Mock;
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  let addr3: SignerWithAddress;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await ethers.getSigners();
  
    // Deploy ERC20 token
    const Token = await ethers.getContractFactory("ERC20Mock") as ERC20Mock__factory;
    token = await Token.deploy()
    await token.waitForDeployment();

    console.log('Token deployed at:', token.target);
  
    // Deploy RefundContract
    RefundContractFactory = await ethers.getContractFactory("RefundContract") as RefundContract__factory;
    refundContract = await RefundContractFactory.deploy(token.target, Math.floor(Date.now() / 1000) + 3600, "admin@example.com");
    await refundContract.waitForDeployment();

    console.log('Refund contract deployed at:', refundContract.target);
  
    await token.transfer(refundContract.target, parseUnits("500", 18));
  });
  describe("Deployment", function () {
    it("Should set the right owner", async function () {  
      expect(await refundContract.owner()).to.equal(owner.address);
    });

    it("Should set the right end refund timestamp", async function () {
      const endRefundTimestamp = await refundContract.endRefundTimestamp();
      expect(endRefundTimestamp).to.be.gt(Math.floor(Date.now() / 1000));
    });

    it("Should set the right admin email", async function () {
      expect(await refundContract.adminEmail()).to.equal("admin@example.com");
    });
  });

  describe("Set Refunds", function () {
    it("Should allow the owner to set refunds", async function () {
      await refundContract.setRefunds([addr1.address, addr2.address], [parseEther("10"), parseEther("20")]);
      expect(await refundContract.refunds(addr1.address)).to.equal(parseEther("10"));
      expect(await refundContract.refunds(addr2.address)).to.equal(parseEther("20"));
    });

    it("Should emit RefundSetEvent when refunds are set", async function () {
      await expect(refundContract.setRefunds([addr1.address], [parseEther("10")]))
        .to.emit(refundContract, "RefundSetEvent")
        .withArgs(addr1.address, parseEther("10"));
    });
  });

  describe("Withdraw Refund", function () {
    beforeEach(async function () {
      await refundContract.setRefunds([addr1.address], [parseEther("10")]);
    });

    it("Should allow users to withdraw their refunds", async function () {
      await refundContract.connect(addr1).withdrawRefund();
      expect(await token.balanceOf(addr1.address)).to.equal(parseEther("10"));
    });

    it("Should emit RefundExecutedEvent when refunds are withdrawn", async function () {
      await expect(refundContract.connect(addr1).withdrawRefund())
        .to.emit(refundContract, "RefundExecutedEvent")
        .withArgs(addr1.address, parseEther("10"));
    });

    it("Should not allow users to withdraw more than once", async function () {
      await refundContract.connect(addr1).withdrawRefund();
      await expect(refundContract.connect(addr1).withdrawRefund()).to.be.revertedWith("No refund or already withdrawn");
    });
  });

  describe("Set End Refund Time", function () {
    it("Should allow the owner to increase the end refund time", async function () {
      const newEndTime = Math.floor(Date.now() / 1000) + 7200;
      await refundContract.setEndRefundTime(newEndTime);
      expect(await refundContract.endRefundTimestamp()).to.equal(newEndTime);
    });

    it("Should not allow the owner to decrease the end refund time", async function () {
      const newEndTime = Math.floor(Date.now() / 1000) + 1800;
      await expect(refundContract.setEndRefundTime(newEndTime)).to.be.revertedWith("End refund time can only be increased");
    });
  });

  describe("Execute Refund Contract Closure", function () {
    beforeEach(async function () {
      await refundContract.setRefunds([addr1.address, addr2.address], [parseEther("10"), parseEther("10")]);
    });

    it("Should allow the owner to execute contract closure if claim percentage is met", async function () {
      await refundContract.connect(addr1).withdrawRefund();
      // Increase time to end refund period
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");
  
      // Execute contract closure
      await refundContract.executeRefundContractClosure();
  
      // Assert the owner's balance
      expect(await token.balanceOf(owner.address)).to.greaterThan(parseEther("10")); // 30 - 10 (claimed by addr1)
    });
  });
});