import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const JAN_1ST_2030 = 1893456000;
const TOKEN_ADDRESS = "0xYourTokenAddressHere"; // Replace with your token address
const ADMIN_EMAIL = "admin@example.com"; // Replace with your admin email

const LockModule = buildModule("LockModule", (m) => {
  const tokenAddress = m.getParameter("tokenAddress", TOKEN_ADDRESS);
  const endRefundTimestamp = m.getParameter("endRefundTimestamp", JAN_1ST_2030);
  const adminEmail = m.getParameter("adminEmail", ADMIN_EMAIL);

  const lock = m.contract("Lock", [tokenAddress, endRefundTimestamp, adminEmail]);

  return { lock };
});

export default LockModule;
