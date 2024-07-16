# Better Refund Contract

Trying to make the refunds better. 
Solidity Contract for EVM chains


## Core Functionality

1- Supports refund of ERC20 Tokens
2- Allows defining per user token allocation in bulk
3- Blocks RugPull 
 a- Cannot change the end time of the contract lock to time already defined in the contract
 b- Admin cannot get refund back if 50% or more of the refunds have not been claimed
 c- Email is to be provided at the time of deployment

# Running the code

```shell
npx hardhat help
npx hardhat test
REPORT_GAS=true npx hardhat test
npx hardhat node
npx hardhat ignition deploy ./ignition/modules/BetterRefund.ts
```
