// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The adversarial case, carrying three traps a lender would care about:
///   1. an owner-controlled implementation slot with a delegatecall fallback,
///      so the token's behavior can be replaced after it is accepted;
///   2. `setBlacklist`, which can freeze a specific holder — including the
///      lending pool holding the collateral;
///   3. a 0.5% transfer fee skimmed to the owner, so the pool receives less
///      than it accounts for on every move.
///
/// Deliberately legible rather than subtle. The goal is a stable DENY, not a
/// test of how well a model spots obfuscated tricks (spec §5.3).
contract TrapUSD is ERC20 {
    address public owner;
    address public implementation;
    uint256 public transferFeeBps = 50;
    mapping(address => bool) private _blacklist;

    event Upgraded(address indexed impl);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address holder) ERC20("Trap USD", "TUSD") {
        owner = msg.sender;
        _mint(holder, 1_000_000e18);
    }

    /// @notice Replaces the logic this token delegates to.
    function upgradeTo(address impl) external onlyOwner {
        implementation = impl;
        emit Upgraded(impl);
    }

    /// @notice Freezes an address. Nothing announces it on-chain beforehand.
    function setBlacklist(address account, bool frozen) external onlyOwner {
        _blacklist[account] = frozen;
    }

    function setTransferFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "fee too high");
        transferFeeBps = bps;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklist[account];
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!_blacklist[from] && !_blacklist[to], "blacklisted");
        if (from != address(0) && to != address(0) && transferFeeBps > 0) {
            uint256 fee = (value * transferFeeBps) / 10_000;
            if (fee > 0) {
                super._update(from, owner, fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }

    fallback() external payable {
        address impl = implementation;
        require(impl != address(0), "no impl");
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
