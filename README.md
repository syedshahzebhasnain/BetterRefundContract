# Better Refund Contract

A Solidity contract designed for EVM chains to enhance the refund process.
THIS CONTRACT IS NOT AUDITED. PROVIDED AS IS. USE AT YOUR OWN RISK.

## Core Functionality

1. **Supports Refund of ERC20 Tokens**: Users can withdraw their refunds in ERC20 tokens.
2. **Bulk User Token Allocation**: Allows the admin to define token allocations for multiple users at once.
3. **RugPull Prevention**:
   - **Immutable End Time**: The end time of the contract can only be increased, not decreased.
   - **Admin Refund Restriction**: The admin cannot reclaim refunds if less than 50% of the refund claimaints have claimed
   - **Deployment Email Requirement**: An email address must be provided at the time of contract deployment for user complaints.

## Running the Code

To interact with and test the contract, use the following commands:

```shell
# Run tests
npx hardhat test

# Run tests with gas reporting
REPORT_GAS=true npx hardhat test

# Start a local Hardhat node
npx hardhat node

# Deploy the contract using Hardhat Ignition
npx hardhat ignition deploy ./ignition/modules/BetterRefund.ts