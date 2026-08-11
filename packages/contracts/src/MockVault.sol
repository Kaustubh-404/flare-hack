// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * A deliberately ordinary deposit vault — the "dApp that has never heard of the
 * XRP Ledger" in the ONESIG demo.
 *
 * There is nothing XRPL-aware here on purpose. It is a plain ERC-20 vault with
 * a `deposit`/`withdraw` pair. The demo's whole point is that ONESIG makes it
 * drivable from an XRPL signature without touching this file.
 *
 * Deployed by us rather than pointed at a live third-party protocol so the demo
 * has no external dependency that can break on recording day.
 */
contract MockVault {
    IERC20 public immutable asset;

    mapping(address account => uint256 amount) public balanceOf;
    uint256 public totalDeposits;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 requested);
    error TransferFailed();

    constructor(IERC20 _asset) {
        asset = _asset;
    }

    function deposit(uint256 _amount) external {
        require(_amount > 0, ZeroAmount());
        if (!asset.transferFrom(msg.sender, address(this), _amount)) revert TransferFailed();
        balanceOf[msg.sender] += _amount;
        totalDeposits += _amount;
        emit Deposited(msg.sender, _amount);
    }

    function withdraw(uint256 _amount) external {
        uint256 available = balanceOf[msg.sender];
        require(_amount > 0, ZeroAmount());
        require(_amount <= available, InsufficientBalance(available, _amount));
        balanceOf[msg.sender] = available - _amount;
        totalDeposits -= _amount;
        if (!asset.transfer(msg.sender, _amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, _amount);
    }
}
