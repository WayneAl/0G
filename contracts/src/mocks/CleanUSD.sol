// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The benign case. Fixed supply, no owner, no hooks, no upgrade path.
/// Nothing here can take a lender's collateral away after the fact.
contract CleanUSD is ERC20 {
    constructor(address holder) ERC20("Clean USD", "CUSD") {
        _mint(holder, 1_000_000e18);
    }
}
