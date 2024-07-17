// SPDX-License-Identifier: MIT
// Better Refund Contract Features:
// 1. Users can withdraw refunds anytime funds are available.
// 2. Admin can set user refunds.
// 3. Admin can set the last refund time (cannot be decreased).
// 4. Admin can set an email address for user complaints.
// 5. Event triggered when full refund amount is available.
// 6. TODO: Add on-chain dispute provision.
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";

contract RefundContract is Ownable {
    // Constant for the minimum claim percentage
    uint256 public constant MIN_CLAIM_RATIO = 0.5 * 1e18;
    IERC20 public token;
    
    mapping(address => uint256) public refunds;
    address[] public refundAddresses;

    uint256 public endRefundTimestamp;
    bool public allRefundsAvailable = false;

    string public adminEmail;

    event RefundSetEvent(address indexed user, uint256 amount);
    event RefundExecutedEvent(address indexed user, uint256 amount);
    event EndRefundsTimestampSet(uint256 endRefundTimestamp);
    event AllRefundsAvailable(bool allRefundsAvailable);
    
    /**
     * @dev Constructor to initialize the contract with token address, end refund timestamp, and admin email.
     * @param _tokenAddress Address of the ERC20 token contract.
     * @param _endRefundTimestamp Timestamp after which refunds are no longer available.
     * @param _adminEmail Email address for user complaints.
     */
    constructor(address _tokenAddress, uint256 _endRefundTimestamp, string memory _adminEmail) Ownable(msg.sender) {
        token = IERC20(_tokenAddress);
        require(_endRefundTimestamp > block.timestamp, "Last refund time should be in the future");
        endRefundTimestamp = _endRefundTimestamp;
        adminEmail = _adminEmail;
    }

    /**
     * @dev Internal function for the admin to set a refund for a user.
     * @param _user Address of the user.
     * @param _amount Amount of the refund.
     */
    function setRefund(address _user, uint256 _amount) internal {
        require(refunds[_user] == 0, "Refund already set for user");
        refunds[_user] = _amount;
        refundAddresses.push(_user);
        emit RefundSetEvent(_user, _amount);
    }

    /**
     * @dev Function for the admin to set refunds for multiple users.
     * @param _users Array of user addresses.
     * @param _amounts Array of refund amounts corresponding to the users.
     */
    function setRefunds( address[] calldata _users, uint256[] calldata _amounts) external onlyOwner {
        require(_users.length == _amounts.length, "Users and amounts length mismatch");
        for (uint256 i = 0; i < _users.length; i++) {
            setRefund(_users[i], _amounts[i]);
        }
    }

        /**
     * @dev Function to set the last refund time. Can only be increased.
     * @param _customTime New end refund timestamp.
     */
    function setEndRefundTime(uint256 _customTime) external onlyOwner {
        // Set the last refund time. This blocks rug pulls
        require(_customTime > endRefundTimestamp, "End refund time can only be increased");
        endRefundTimestamp = _customTime;
        emit EndRefundsTimestampSet(endRefundTimestamp);
    }

    /**
     * @dev Function to set the admin email address.
     * @param _email New admin email address.
     */
    function setComplainEmail(string calldata _email) external onlyOwner {
        adminEmail = _email;
    }

    /**
     * @dev Function for users to withdraw their refund.
     */
    function withdrawRefund() external {
        uint256 amount = refunds[msg.sender];
        require(amount > 0, "No refund or already withdrawn");
        // to prevent re-entrancy attacks
        refunds[msg.sender] = 0;

        require(token.transfer(msg.sender, amount), "Token transfer failed");
        emit RefundExecutedEvent(msg.sender, amount);
    }

    /**
     * @dev Function to execute a final transfer back to the owner of unclaimed refunds.
     */
    function executeRefundContractClosure() external onlyOwner {
        require(block.timestamp >= endRefundTimestamp, "Wait for end refund time");

        uint256 totalRefundsCount = refundAddresses.length;
        uint256 claimedRefundsCount = 0;

        for (uint256 i = 0; i < refundAddresses.length; i++) {
            if (refunds[refundAddresses[i]] > 0) {
                claimedRefundsCount++;
            }
        }
        uint256 claimRatio = claimedRefundsCount * 1e18 / totalRefundsCount;
        require(claimRatio >= MIN_CLAIM_RATIO, "Claim percentage is less than minimum claim percentage");

        uint256 amount = token.balanceOf(address(this));
        require(token.transfer(owner(), amount), "Token transfer failed");

        emit RefundExecutedEvent(owner(), amount); 
    }

    /**
     * @dev Function to check if all refunds are available.
     */
    function checkAllRefundsAvailable() external {
        require(!allRefundsAvailable, "All refund amount already available");
        uint256 totalRefunds = 0;
        for (uint256 i = 0; i < refundAddresses.length; i++) {
            totalRefunds += refunds[refundAddresses[i]];
        }

        require(token.balanceOf(address(this)) >= totalRefunds, "Not enough tokens in contract. Please top up");
        allRefundsAvailable = true;
    }
}